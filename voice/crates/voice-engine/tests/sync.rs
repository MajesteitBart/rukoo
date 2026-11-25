//! Bucket sync through the whole engine against the real recorder and the fake bucket (spec
//! RUK-110 4.5), and media links through `media.open` and `media.read`.
//!
//! Like tests/meetings.rs, this binary has its own main (`harness = false`) so it can also be the
//! recorder and the screen process: run with `VOICE_ENGINE_TEST_ROLE=recorder` it calls
//! `voice_recorder::run`, or `voice_screen::run` for arguments without `--track`. Sources are
//! synthetic tones and the screen tests record the screen process's synthetic screen; no real
//! audio or screen is recorded.

mod support;

use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde_json::{json, Value};
use support::{
    bucket_kinds, connect_bucket, decrypt_all, fake_s3, fast_sync, skip_on_slow_host, sync_state,
    wait_for, Harness,
};
use voice_bridge::{ControlError, EventLog, MediaKind, MediaOpenArgs, MeetingControl};
use voice_engine::media::ScreenMedia;
use voice_engine::meetings::controller::ControllerTiming;
use voice_engine::meetings::screen::ScreenTiming;
use voice_engine::{Engine, StopReason};
use voice_meetings::{TrackReader, Transcript};
use voice_protocol::{ErrorCode, MeetingId, Speaker, Track};
use voice_recorder::timeline::{self, History, Line};
use voice_s3_fake::{FakeS3, Op};
use voice_screen_files::journal::Line as ScreenLine;
use voice_sync::{ScreenFile, ScreenFileKind, ScreenFiles};

const ROLE: &str = "VOICE_ENGINE_TEST_ROLE";

fn main() {
    struct Warnings;
    impl log::Log for Warnings {
        fn enabled(&self, metadata: &log::Metadata) -> bool {
            metadata.level() <= log::Level::Warn
        }
        fn log(&self, record: &log::Record) {
            if self.enabled(record.metadata()) {
                eprintln!("{}: {}", record.target(), record.args());
            }
        }
        fn flush(&self) {}
    }
    static WARNINGS: Warnings = Warnings;
    let _ = log::set_logger(&WARNINGS);
    log::set_max_level(log::LevelFilter::Warn);
    if std::env::var(ROLE).as_deref() == Ok("recorder") {
        let args: Vec<String> = std::env::args().skip(1).collect();
        // Only the recorder takes `--track`; the screen process never does.
        if args.iter().any(|a| a == "--track") {
            if let Err(e) = voice_recorder::run(&args) {
                eprintln!("rukoo-voice-recorder: {e}");
                std::process::exit(e.code);
            }
        } else if let Err(e) = voice_screen::run(&args) {
            eprintln!("rukoo-voice-screen: {e}");
            std::process::exit(e.code);
        }
        return;
    }
    // Single-threaded here, so setting the variables is safe; every recorder and screen process
    // started from now on inherits them. The screen process takes `--test` only in a development
    // copy.
    std::env::set_var(ROLE, "recorder");
    let scratch = std::env::temp_dir().join(format!("voice-engine-sync-{}", std::process::id()));
    std::env::set_var(voice_core::paths::DATA_DIR_ENV, &scratch);
    let tests: Vec<(&str, fn())> = vec![
        (
            "a_meeting_uploads_while_it_records",
            a_meeting_uploads_while_it_records,
        ),
        (
            "a_failing_bucket_never_slows_the_recorder",
            a_failing_bucket_never_slows_the_recorder,
        ),
        (
            "retention_keeps_audio_that_hasn_t_uploaded",
            retention_keeps_audio_that_hasn_t_uploaded,
        ),
        (
            "media_open_and_read_give_the_mix",
            media_open_and_read_give_the_mix,
        ),
        (
            "a_live_meeting_s_audio_link_grows_with_the_recording",
            a_live_meeting_s_audio_link_grows_with_the_recording,
        ),
        (
            "media_comes_back_from_the_bucket",
            media_comes_back_from_the_bucket,
        ),
        (
            "a_timeline_cant_point_a_link_outside_the_meeting",
            a_timeline_cant_point_a_link_outside_the_meeting,
        ),
        (
            "a_restored_meeting_reaches_the_bridge",
            a_restored_meeting_reaches_the_bridge,
        ),
        (
            "changes_and_deletions_reach_the_other_computer",
            changes_and_deletions_reach_the_other_computer,
        ),
        (
            "a_pulled_meeting_s_media_comes_on_request_within_the_cache_limit",
            a_pulled_meeting_s_media_comes_on_request_within_the_cache_limit,
        ),
        (
            "a_passage_from_the_bucket_starts_after_its_first_segment",
            a_passage_from_the_bucket_starts_after_its_first_segment,
        ),
        (
            "media_open_for_video_answers_within_50_ms",
            media_open_for_video_answers_within_50_ms,
        ),
        (
            "media_open_serves_a_frame_and_opens_a_gone_clip_again",
            media_open_serves_a_frame_and_opens_a_gone_clip_again,
        ),
        (
            "retention_releases_holds_when_the_disk_runs_low",
            retention_releases_holds_when_the_disk_runs_low,
        ),
        (
            "retention_holds_when_the_queue_is_unreadable",
            retention_holds_when_the_queue_is_unreadable,
        ),
        (
            "repairing_a_failing_bucket_keeps_held_audio",
            repairing_a_failing_bucket_keeps_held_audio,
        ),
        (
            "screen_files_upload_by_their_rules",
            screen_files_upload_by_their_rules,
        ),
        (
            "media_open_serves_a_frame_and_a_clip",
            media_open_serves_a_frame_and_a_clip,
        ),
        ("retention_holds_screen_media", retention_holds_screen_media),
        (
            "a_restored_meeting_keeps_its_speakers",
            a_restored_meeting_keeps_its_speakers,
        ),
        (
            "the_key_dialogs_wait_while_the_screen_records",
            the_key_dialogs_wait_while_the_screen_records,
        ),
        #[cfg(target_os = "macos")]
        (
            "a_refused_keychain_shows_in_settings_until_allowed",
            a_refused_keychain_shows_in_settings_until_allowed,
        ),
        #[cfg(target_os = "macos")]
        (
            "the_keychain_dialog_holds_up_neither_the_start_nor_a_meeting",
            the_keychain_dialog_holds_up_neither_the_start_nor_a_meeting,
        ),
    ];
    let filters: Vec<String> = std::env::args()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .collect();
    let mut failed = Vec::new();
    let mut ran = 0;
    for (name, test) in tests {
        if !filters.is_empty() && !filters.iter().any(|f| name.contains(f.as_str())) {
            continue;
        }
        ran += 1;
        let started = Instant::now();
        match panic::catch_unwind(AssertUnwindSafe(test)) {
            Ok(()) => println!("test {name} ... ok ({} ms)", started.elapsed().as_millis()),
            Err(_) => {
                println!("test {name} ... FAILED");
                failed.push(name);
            }
        }
    }
    println!(
        "test result: {}. {} passed; {} failed",
        if failed.is_empty() { "ok" } else { "FAILED" },
        ran - failed.len(),
        failed.len()
    );
    if !failed.is_empty() {
        std::process::exit(101);
    }
}

// Helpers ------------------------------------------------------------------------------------

/// An engine on fakes that records with the real recorder: 1-second segments, a tone on each
/// track, and bucket sync's clocks shortened.
fn harness(name: &str, config: Value) -> Harness {
    let mut h = Harness::new(name);
    h.recorder_exe = std::env::current_exe().unwrap();
    h.timing = ControllerTiming {
        poll: Duration::from_millis(100),
        start_timeout: Duration::from_secs(20),
        backoff: vec![
            Duration::from_millis(100),
            Duration::from_millis(100),
            Duration::from_millis(200),
            Duration::from_millis(300),
        ],
        stable_after: Duration::from_secs(60),
        ping_failures: 3,
        recorder_args: vec!["--segment-ms".into(), "1000".into()],
    };
    h.test_sources = Some("mic=synthetic:tone:440,call=synthetic:tone:600".into());
    h.sync_timing = fast_sync();
    h.config(config);
    h
}

/// Waits up to `limit`, for the long waits of a failing bucket.
fn wait_long(what: &str, limit: Duration, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + limit;
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn meeting_dir(data: &Path, id: &str) -> PathBuf {
    data.join("meetings").join(id)
}

fn lines(data: &Path, id: &str) -> Vec<Line> {
    timeline::read(&meeting_dir(data, id).join("timeline.jsonl")).unwrap_or_default()
}

fn wait_recorded(data: &Path, id: &str, at_least: u64) {
    wait_long(
        &format!("{at_least} ms of audio"),
        Duration::from_millis(at_least) + Duration::from_secs(30),
        || {
            lines(data, id)
                .iter()
                .any(|l| matches!(l, Line::Heartbeat { t, .. } if *t >= at_least))
        },
    );
}

fn wait_done(data: &Path, id: &str) {
    wait_long("meeting.state done", Duration::from_secs(60), || {
        EventLog::open(data)
            .unwrap()
            .after(0)
            .unwrap()
            .iter()
            .any(|s| {
                s.meeting.as_deref() == Some(id)
                    && s.event == "meeting.state"
                    && s.data["state"] == "done"
            })
    });
}

/// Records `ms` of a meeting, stops it and waits until it is done.
fn record(engine: &Engine, data: &Path, ms: u64) -> String {
    let id = engine.start_meeting().unwrap();
    wait_recorded(data, &id, ms);
    engine.stop_meeting(StopReason::User).unwrap();
    wait_done(data, &id);
    id
}

/// The recovery code; tests keep it to open the bucket's objects.
fn recovery_code(engine: &Engine) -> String {
    engine.settings_sync_key("show", None).unwrap()["code"]
        .as_str()
        .unwrap()
        .to_string()
}

fn wait_uploaded(engine: &Engine) {
    wait_long("every file in the bucket", Duration::from_secs(60), || {
        let state = sync_state(engine);
        state["waiting"] == 0 && state["state"] == "idle"
    });
}

fn audio(meeting: &str, start: u64, end: Option<u64>) -> MediaOpenArgs {
    MediaOpenArgs {
        meeting: MeetingId::parse(meeting).unwrap(),
        kind: MediaKind::Audio,
        start,
        end,
        piece: false,
    }
}

/// `media.open` until the file is ready; the ready answer.
fn open_ready(control: &dyn MeetingControl, args: &MediaOpenArgs) -> Value {
    let mut answer = Value::Null;
    wait_long("prepared media", Duration::from_secs(60), || {
        answer = control.media_open(args).expect("media.open");
        answer["ready"] == true
    });
    answer
}

/// The whole prepared file through `media.read`, in pieces of `piece` bytes.
fn read_all(control: &dyn MeetingControl, ready: &Value, piece: u64) -> Vec<u8> {
    let media = ready["media"].as_str().unwrap();
    let size = ready["size"].as_u64().unwrap();
    let mut bytes = Vec::new();
    while (bytes.len() as u64) < size {
        let offset = bytes.len() as u64;
        let reply = control.media_read(media, offset, piece).unwrap();
        assert_eq!(reply["offset"], offset);
        let data = base64::engine::general_purpose::STANDARD
            .decode(reply["data"].as_str().unwrap())
            .unwrap();
        assert!(!data.is_empty() && data.len() as u64 <= piece);
        bytes.extend(data);
    }
    assert_eq!(bytes.len() as u64, size);
    // Past the end there is nothing more.
    let past = control.media_read(media, size, piece).unwrap();
    assert_eq!(past["data"], "");
    bytes
}

/// The mix of every track from `start` to `end` ms, as a WAV file.
fn expected_mix(dir: &Path, start: u64, end: u64) -> Vec<u8> {
    let history = History::from_lines(&timeline::read(&dir.join("timeline.jsonl")).unwrap());
    let readers: Vec<TrackReader> = ["mic", "call"]
        .iter()
        .map(|track| TrackReader::new(dir, track, &history.segments))
        .collect();
    let (from, to) = (start * 16, end * 16);
    let mut sum = vec![0i32; (to - from) as usize];
    for reader in &readers {
        for (total, sample) in sum.iter_mut().zip(reader.read(from, to).unwrap()) {
            *total += i32::from(sample);
        }
    }
    let mut wav = voice_audio::segment_header(to - from).to_vec();
    for s in sum {
        wav.extend_from_slice(&(s.clamp(-32768, 32767) as i16).to_le_bytes());
    }
    wav
}

/// The meeting time just after the last recorded sample of any track, in ms rounded up.
fn recorded_end(dir: &Path) -> u64 {
    let history = History::from_lines(&timeline::read(&dir.join("timeline.jsonl")).unwrap());
    ["mic", "call"]
        .iter()
        .map(|track| TrackReader::new(dir, track, &history.segments).end())
        .max()
        .unwrap()
        .div_ceil(16)
}

fn code_of<T: std::fmt::Debug>(result: Result<T, ControlError>) -> ErrorCode {
    result.unwrap_err().code
}

fn wall_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

// Uploads ------------------------------------------------------------------------------------

fn a_meeting_uploads_while_it_records() {
    let h = harness("sync-live", json!({"meetings_retention": "keep"}));
    let fake = fake_s3();
    let engine = h.start();
    connect_bucket(&engine, &fake.endpoint());
    let code = recovery_code(&engine);
    let id = engine.start_meeting().unwrap();
    wait_for("sync to say a meeting records", || {
        sync_state(&engine)["state"] == "live"
    });
    wait_recorded(&h.data(), &id, 4000);
    wait_for("audio in the bucket while the meeting records", || {
        bucket_kinds(&fake, &code).contains(&"audio")
    });
    let live = bucket_kinds(&fake, &code);
    assert!(live.contains(&"meeting"), "{live:?}");
    assert!(
        !live.contains(&"timeline") && !live.contains(&"transcript"),
        "the text waits for the stop: {live:?}"
    );
    assert!(!lines(&h.data(), &id)
        .iter()
        .any(|l| matches!(l, Line::Stop { .. })));

    engine.stop_meeting(StopReason::User).unwrap();
    wait_done(&h.data(), &id);
    wait_long(
        "the transcript, the timeline, the manifest and the index",
        Duration::from_secs(60),
        || {
            let kinds = bucket_kinds(&fake, &code);
            ["timeline", "transcript", "manifest", "index"]
                .iter()
                .all(|k| kinds.contains(k))
        },
    );
    wait_uploaded(&engine);
    assert!(sync_state(&engine)["lastUpload"].is_u64());

    // Every closed segment is in the bucket byte for byte, and so is meeting.json.
    let dir = meeting_dir(&h.data(), &id);
    let objects = decrypt_all(&fake, &code);
    let history = History::from_lines(&lines(&h.data(), &id));
    assert!(
        history.segments.len() >= 8,
        "{} segments",
        history.segments.len()
    );
    for segment in &history.segments {
        let bytes = std::fs::read(dir.join(&segment.file)).unwrap();
        assert!(
            objects.iter().any(|(_, plain)| *plain == bytes),
            "{} isn't in the bucket",
            segment.file
        );
    }
    let meeting_json = std::fs::read(dir.join("meeting.json")).unwrap();
    assert!(objects.iter().any(|(_, plain)| *plain == meeting_json));
    // No object name shows the meeting or what it holds.
    for (name, _) in &objects {
        assert!(!name.contains("m-20") && !name.contains(".wav"), "{name}");
    }
    engine.shutdown();
    fake.stop();
}

/// Every heartbeat within 1,300 ms of the one before, no lost device or crash, each segment
/// closed and following the one before, and a stop. A failure names the bucket's fault and
/// carries the recorder's log, whose slow-call and late-tick lines say what held it up (#209).
fn assert_steady(data: &Path, id: &str, fault: &str) {
    let fail = |what: String| -> ! {
        let log_path = voice_core::paths::logs_dir(data).join(format!("recorder-{id}.log"));
        let log = std::fs::read_to_string(&log_path)
            .unwrap_or_else(|e| format!("(can't read {}: {e})", log_path.display()));
        panic!("{id}, with {fault}: {what}\nrecorder log:\n{log}");
    };
    let lines = lines(data, id);
    let mut last: Option<u64> = None;
    for line in &lines {
        match line {
            Line::Heartbeat { t, .. } => {
                if let Some(before) = last {
                    if t - before > 1300 {
                        fail(format!("heartbeats {before} and {t}"));
                    }
                }
                last = Some(*t);
            }
            Line::DeviceLost { .. } | Line::Crash { .. } => fail(format!("{line:?}")),
            _ => {}
        }
    }
    if !matches!(lines.last(), Some(Line::Stop { .. })) {
        fail("no stop".into());
    }
    let history = History::from_lines(&lines);
    for track in ["mic", "call"] {
        let mut segments: Vec<_> = history
            .segments
            .iter()
            .filter(|s| s.track == track)
            .collect();
        segments.sort_by_key(|s| s.seq);
        if segments.len() < 20 {
            fail(format!("{track} has {} segments", segments.len()));
        }
        for pair in segments.windows(2) {
            if pair[1].seq != pair[0].seq + 1 {
                fail(format!(
                    "{track} segment {} follows {}",
                    pair[1].seq, pair[0].seq
                ));
            }
            let Some(samples) = pair[0].ended else {
                fail(format!("{track} segment {} never ended", pair[0].seq));
            };
            let end = pair[0].t + samples / 16;
            if pair[1].t.abs_diff(end) > 200 {
                fail(format!(
                    "{track}: a gap between {} and {}",
                    pair[0].seq, pair[1].seq
                ));
            }
        }
        if let Some(open) = segments.iter().find(|s| s.ended.is_none()) {
            fail(format!("{track} segment {} never ended", open.seq));
        }
    }
}

fn a_failing_bucket_never_slows_the_recorder() {
    // Its heartbeat limits (see `assert_steady`) are timing windows.
    if skip_on_slow_host("a_failing_bucket_never_slows_the_recorder") {
        return;
    }
    let h = harness("sync-failing", json!({"meetings_retention": "keep"}));
    let fake = fake_s3();
    let engine = h.start();
    connect_bucket(&engine, &fake.endpoint());
    type Fault = fn(&FakeS3);
    let faults: [(&str, Fault); 3] = [
        ("a bucket that stalls every answer for 30 s", |fake| {
            fake.faults().stall = Some(Duration::from_secs(30));
        }),
        ("a bucket that refuses connections", |fake| {
            fake.faults().refuse = true;
        }),
        ("a bucket that answers 500", |fake| {
            let mut faults = fake.faults();
            for op in [Op::Put, Op::Create, Op::UploadPart, Op::Complete] {
                faults
                    .fail
                    .extend(std::iter::repeat_n((op, 500, "InternalError"), 10_000));
            }
        }),
    ];
    let mut meetings = Vec::new();
    for (what, fault) in faults {
        println!("  {what}");
        *fake.faults() = Default::default();
        fault(&fake);
        let id = engine.start_meeting().unwrap();
        wait_long("sync to retry", Duration::from_secs(40), || {
            sync_state(&engine)["state"] == "retrying"
        });
        wait_recorded(&h.data(), &id, 25_000);
        engine.stop_meeting(StopReason::User).unwrap();
        wait_long("the stop", Duration::from_secs(30), || {
            lines(&h.data(), &id)
                .iter()
                .any(|l| matches!(l, Line::Stop { .. }))
        });
        assert_steady(&h.data(), &id, what);
        meetings.push(id);
    }
    // Healthy again: everything goes up.
    *fake.faults() = Default::default();
    for id in &meetings {
        wait_done(&h.data(), id);
    }
    wait_long("the queue to drain", Duration::from_secs(120), || {
        let state = sync_state(&engine);
        state["waiting"] == 0 && state["state"] == "idle"
    });
    let code = recovery_code(&engine);
    let kinds = bucket_kinds(&fake, &code);
    let audio = kinds.iter().filter(|k| **k == "audio").count();
    let segments: usize = meetings
        .iter()
        .map(|id| History::from_lines(&lines(&h.data(), id)).segments.len())
        .sum();
    assert_eq!(audio, segments, "every segment once");
    assert_eq!(kinds.iter().filter(|k| **k == "timeline").count(), 3);
    engine.shutdown();
    fake.stop();
}

// Retention ----------------------------------------------------------------------------------

fn retention_keeps_audio_that_hasn_t_uploaded() {
    // "Remove after transcription": the meeting's time is up as soon as it is done.
    let h = harness(
        "sync-retention",
        json!({"meetings_retention": "after_transcription"}),
    );
    let fake = fake_s3();
    let engine = h.start();
    connect_bucket(&engine, &fake.endpoint());
    fake.faults().refuse = true;
    let held = record(&engine, &h.data(), 2000);
    // The engine sweeps right after it reads `done`, within a second or two.
    std::thread::sleep(Duration::from_millis(3000));
    let audio = meeting_dir(&h.data(), &held).join("audio");
    assert!(audio.is_dir(), "audio that isn't in the bucket stays");
    assert!(sync_state(&engine)["waiting"].as_u64().unwrap() > 0);

    // Once it is in the bucket, the next sweep removes it.
    fake.faults().refuse = false;
    wait_long("the uploaded audio to go", Duration::from_secs(60), || {
        !audio.exists()
    });
    assert!(meeting_dir(&h.data(), &held)
        .join("timeline.jsonl")
        .is_file());

    // With sync off, a meeting's audio goes as soon as it is done.
    engine
        .settings_set("storage.sync.enabled", json!(false))
        .unwrap();
    fake.faults().refuse = true;
    let free = record(&engine, &h.data(), 2000);
    wait_for("the audio to go without sync", || {
        !meeting_dir(&h.data(), &free).join("audio").exists()
    });
    engine.shutdown();
    fake.stop();
}

fn retention_releases_holds_when_the_disk_runs_low() {
    let h = harness(
        "sync-floor",
        json!({"meetings_retention": "after_transcription"}),
    );
    let fake = fake_s3();
    let engine = h.start();
    connect_bucket(&engine, &fake.endpoint());
    fake.faults().refuse = true;
    let older = record(&engine, &h.data(), 2000);
    let newer = record(&engine, &h.data(), 2000);
    assert!(older < newer);
    let live = engine.start_meeting().unwrap();
    wait_recorded(&h.data(), &live, 1000);
    for id in [&older, &newer, &live] {
        assert!(meeting_dir(&h.data(), id).join("audio").is_dir(), "{id}");
    }
    // 9 GiB free until the older meeting's audio goes, then 10 GiB.
    let older_audio = meeting_dir(&h.data(), &older).join("audio");
    h.set_free(move |_| {
        Some(if older_audio.exists() {
            9 << 30
        } else {
            10 << 30
        })
    });
    // A new start sweeps at once; the recorder records on meanwhile.
    engine.shutdown();
    let engine = h.start();
    wait_for("the older meeting's audio to go", || {
        !meeting_dir(&h.data(), &older).join("audio").exists()
    });
    assert!(meeting_dir(&h.data(), &newer).join("audio").is_dir());
    assert!(meeting_dir(&h.data(), &live).join("audio").is_dir());
    wait_for("the lost files counted", || {
        sync_state(&engine)["lost"].as_u64().unwrap_or(0) > 0
    });
    let notes: Vec<_> = h
        .sink
        .notes()
        .into_iter()
        .filter(|n| n.title_key == voice_engine::NOTIFY_SYNC)
        .collect();
    assert_eq!(notes.len(), 1, "{notes:?}");
    assert!(notes[0].body.contains("hadn't reached your bucket"));
    engine.stop_meeting(StopReason::User).unwrap();
    wait_long("the stop", Duration::from_secs(30), || {
        lines(&h.data(), &live)
            .iter()
            .any(|l| matches!(l, Line::Stop { .. }))
    });
    engine.shutdown();
    fake.stop();
}

/// The usual repair of a failing bucket: a new secret, a corrected field, or the secret removed
/// and saved again. Each pauses uploads until Test connection passes, and none may let retention
/// take audio that never reached the bucket (D6, D8, spec 2.15 "Wrong secret").
fn repairing_a_failing_bucket_keeps_held_audio() {
    let h = harness(
        "sync-repair",
        json!({"meetings_retention": "after_transcription"}),
    );
    let fake = fake_s3();
    let engine = h.start();
    connect_bucket(&engine, &fake.endpoint());
    fake.faults().refuse = true;
    let held = record(&engine, &h.data(), 2000);
    std::thread::sleep(Duration::from_millis(3000));
    let audio = meeting_dir(&h.data(), &held).join("audio");
    assert!(audio.is_dir(), "held for the bucket");

    let sync_settings =
        |engine: &Engine| engine.settings_state()["config"]["storage"]["sync"].clone();
    engine
        .settings_sync_save_secret("a-replacement-secret".into())
        .unwrap();
    assert_eq!(
        sync_settings(&engine)["enabled"],
        true,
        "the switch stays on"
    );
    assert_eq!(sync_settings(&engine)["tested"], false);
    assert_eq!(sync_state(&engine)["state"], "paused");
    engine
        .settings_set("storage.sync.bucket", json!("corrected-bucket"))
        .unwrap();
    engine.settings_remove_key("sync").unwrap();
    assert_eq!(sync_state(&engine)["state"], "paused");
    // Longer than the engine waits before it sweeps again after a sync change.
    std::thread::sleep(Duration::from_millis(7000));
    assert!(audio.is_dir(), "a paused sync keeps holding");
    // A start sweeps at once.
    engine.shutdown();
    let engine = h.start();
    std::thread::sleep(Duration::from_millis(3000));
    assert!(audio.is_dir(), "still held after a sweep");
    assert_eq!(sync_state(&engine)["state"], "paused");

    // Repaired: the right bucket and secret pass the test, uploads go on by themselves, and the
    // audio goes once it is in the bucket.
    engine
        .settings_set("storage.sync.bucket", json!(support::BUCKET))
        .unwrap();
    engine
        .settings_sync_save_secret(support::BUCKET_SECRET.into())
        .unwrap();
    fake.faults().refuse = false;
    engine.settings_sync_test().unwrap();
    assert_ne!(sync_state(&engine)["state"], "paused");
    wait_long("the uploaded audio to go", Duration::from_secs(60), || {
        !audio.exists()
    });
    engine.shutdown();
    fake.stop();
}

/// An empty SQLite database whose `user_version` is 2: a queue from a newer Voice.
fn newer_queue_db() -> Vec<u8> {
    let mut db = vec![0u8; 4096];
    db[..16].copy_from_slice(b"SQLite format 3\0");
    db[16..18].copy_from_slice(&4096u16.to_be_bytes());
    db[18] = 1;
    db[19] = 1;
    db[21] = 64;
    db[22] = 32;
    db[23] = 32;
    db[24..28].copy_from_slice(&1u32.to_be_bytes()); // change counter
    db[28..32].copy_from_slice(&1u32.to_be_bytes()); // pages
    db[40..44].copy_from_slice(&1u32.to_be_bytes()); // schema cookie
    db[44..48].copy_from_slice(&4u32.to_be_bytes()); // schema format
    db[56..60].copy_from_slice(&1u32.to_be_bytes()); // UTF-8
    db[60..64].copy_from_slice(&2u32.to_be_bytes()); // user_version
    db[92..96].copy_from_slice(&1u32.to_be_bytes());
    db[96..100].copy_from_slice(&3_045_000u32.to_be_bytes());
    // Page 1: an empty table leaf whose cells would start at the end of the page.
    db[100] = 0x0D;
    db[105..107].copy_from_slice(&4096u16.to_be_bytes());
    db
}

fn retention_holds_when_the_queue_is_unreadable() {
    // Sync is on for a tested bucket, but its queue is from a newer Voice.
    let mut sync = json!({
        "enabled": true, "service": "other", "endpoint": "http://127.0.0.1:9",
        "region": "us-east-1", "bucket": "test", "accessKeyId": "test", "urlStyle": "path"
    });
    sync["tested"] = json!(voice_sync::SyncConfig::from_json(&sync)
        .unwrap()
        .fingerprint());
    let h = harness(
        "sync-unreadable",
        json!({"meetings_retention": "after_transcription", "storage_sync": sync}),
    );
    let queue = h.data().join("sync");
    std::fs::create_dir_all(&queue).unwrap();
    std::fs::write(queue.join("queue.db"), newer_queue_db()).unwrap();
    let engine = h.start();
    let view = sync_state(&engine);
    assert_eq!(view["available"], false);
    assert_eq!(engine.settings_state()["features"]["sync"], false);
    // What Settings › Storage shows with the switch instead of the sync card: nothing uploads, and
    // why under Error details.
    assert_eq!(view["state"], "paused");
    assert_eq!(view["lastError"]["code"], "failed");
    assert!(
        view["lastError"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("from a newer Voice")),
        "{view}"
    );
    let id = record(&engine, &h.data(), 2000);
    std::thread::sleep(Duration::from_millis(3000));
    let audio = meeting_dir(&h.data(), &id).join("audio");
    assert!(audio.is_dir(), "a broken queue never lets audio go");

    // Turning the switch off, which that page keeps, is the way out.
    engine
        .settings_set("storage.sync.enabled", json!(false))
        .unwrap();
    wait_for("the audio to go with the switch off", || !audio.exists());
    engine.shutdown();
}

// Media links --------------------------------------------------------------------------------

fn a_live_meeting_s_audio_link_grows_with_the_recording() {
    let h = harness("media-live", json!({"meetings_retention": "keep"}));
    let engine = h.start();
    let id = engine.start_meeting().unwrap();
    wait_recorded(&h.data(), &id, 1500);
    let control = engine.meeting_control().unwrap();
    // Ten minutes asked while about two seconds are recorded: cut to what is there.
    let args = audio(&id, 0, Some(600_000));
    let first = open_ready(&*control, &args);
    let held = first["end"].as_u64().unwrap();
    assert!(held < 600_000, "{first}");
    // Once the meeting recorded on, the same arguments mix up to the new end instead of handing
    // back the short file.
    wait_recorded(&h.data(), &id, held + 2000);
    let second = open_ready(&*control, &args);
    assert!(
        second["end"].as_u64().unwrap() > held,
        "{first} then {second}"
    );
    assert_ne!(second["media"], first["media"], "a new mix");
    // The short mix still answers for the range it holds.
    let again = open_ready(&*control, &audio(&id, 0, Some(held)));
    assert_eq!(again["media"], first["media"]);
    engine.stop_meeting(StopReason::User).unwrap();
    wait_done(&h.data(), &id);
}

fn media_open_and_read_give_the_mix() {
    let h = harness("media-mix", json!({"meetings_retention": "keep"}));
    let engine = h.start();
    let id = record(&engine, &h.data(), 3000);
    let control = engine.meeting_control().unwrap();
    let dir = meeting_dir(&h.data(), &id);
    let end = recorded_end(&dir);
    assert!(end < 20_000);

    // 0 to 20 s: cut to what was recorded.
    let args = audio(&id, 0, Some(20_000));
    let first = control.media_open(&args).unwrap();
    assert_eq!(first["ready"], false, "{first}");
    let ready = open_ready(&*control, &args);
    assert_eq!(
        ready["media"], first["media"],
        "the same arguments, the same media"
    );
    assert_eq!(
        (
            &ready["type"],
            &ready["start"],
            &ready["end"],
            &ready["size"]
        ),
        (
            &json!("audio/wav"),
            &json!(0),
            &json!(end),
            &json!(44 + end * 32)
        )
    );
    let wav = read_all(&*control, &ready, 100_000);
    assert_eq!(wav, expected_mix(&dir, 0, end));
    // The mix holds both tones, not silence.
    assert!(wav[44..].iter().any(|b| *b != 0));

    // A range inside, read in other pieces.
    let inner = open_ready(&*control, &audio(&id, 1000, Some(2500)));
    assert_eq!(
        read_all(&*control, &inner, 7_001),
        expected_mix(&dir, 1000, 2500)
    );

    // What isn't there.
    assert_eq!(
        code_of(control.media_open(&audio(&id, end, Some(end + 1000)))),
        ErrorCode::NotFound
    );
    assert_eq!(
        code_of(control.media_open(&audio(&id, 0, None))),
        ErrorCode::BadRequest
    );
    assert_eq!(
        code_of(control.media_open(&audio("m-20000101-000000-abcd", 0, Some(1000)))),
        ErrorCode::NotFound
    );
    let frame = MediaOpenArgs {
        kind: MediaKind::Frame,
        ..audio(&id, 0, None)
    };
    assert_eq!(code_of(control.media_open(&frame)), ErrorCode::NotAvailable);
    let video = MediaOpenArgs {
        kind: MediaKind::Video,
        ..audio(&id, 0, Some(400_000))
    };
    assert_eq!(code_of(control.media_open(&video)), ErrorCode::BadRequest);
    assert_eq!(
        code_of(control.media_read("md-AAAAAAAAAAAAAAAAAAAAAA", 0, 10)),
        ErrorCode::NotFound
    );
    // Nothing is left behind but the prepared mixes.
    let prepared = std::fs::read_dir(h.data().join("media")).unwrap().count();
    assert_eq!(prepared, 2);
    engine.shutdown();
}

fn media_comes_back_from_the_bucket() {
    let h = harness("media-fetch", json!({"meetings_retention": "keep"}));
    let fake = fake_s3();
    let engine = h.start();
    connect_bucket(&engine, &fake.endpoint());
    let id = record(&engine, &h.data(), 3000);
    wait_uploaded(&engine);
    let control = engine.meeting_control().unwrap();
    let dir = meeting_dir(&h.data(), &id);
    let before = read_all(
        &*control,
        &open_ready(&*control, &audio(&id, 0, Some(20_000))),
        1 << 20,
    );

    // Retention removed the audio here; the bucket still has it.
    std::fs::remove_dir_all(dir.join("audio")).unwrap();
    let args = audio(&id, 0, Some(20_001));
    let first = control.media_open(&args).unwrap();
    assert_eq!(first["ready"], false, "{first}");
    let after = read_all(&*control, &open_ready(&*control, &args), 1 << 20);
    assert_eq!(after, before, "the same mix from the bucket");
    let history = History::from_lines(&lines(&h.data(), &id));
    assert!(history.segments.iter().all(|s| dir.join(&s.file).is_file()));

    // Fetched audio stays a day after its last use, not after its fetch (D8): another link to it
    // a little later, from the files now on disk, moves the hold on.
    let fetched = wall_ms();
    std::thread::sleep(Duration::from_millis(400));
    let _ = read_all(
        &*control,
        &open_ready(&*control, &audio(&id, 0, Some(20_003))),
        1 << 20,
    );
    let queue = voice_sync::queue::Queue::open(&h.data().join("sync")).unwrap();
    let later = fetched + voice_sync::queue::RESTORED_HOLD_MS + 200;
    assert!(
        queue.holds_media(&id, false, true, later).unwrap(),
        "the hold counts from the last use"
    );
    drop(queue);

    // With sync off, Voice never asks the bucket.
    engine
        .settings_set("storage.sync.enabled", json!(false))
        .unwrap();
    std::fs::remove_dir_all(dir.join("audio")).unwrap();
    assert_eq!(
        code_of(control.media_open(&audio(&id, 0, Some(20_002)))),
        ErrorCode::NotAvailable
    );
    engine.shutdown();
    fake.stop();
}

fn a_timeline_cant_point_a_link_outside_the_meeting() {
    let h = harness("media-outside", json!({"meetings_retention": "keep"}));
    // A file elsewhere on this computer, and a meeting whose timeline names it twice, as one from
    // the bucket could: by its absolute path and through `..`.
    let outside = h.data().join("outside.pdf");
    let bytes: Vec<u8> = b"NOT-A-MEETING-FILE-"
        .iter()
        .cycle()
        .take(200_044)
        .copied()
        .collect();
    std::fs::create_dir_all(h.data()).unwrap();
    std::fs::write(&outside, &bytes).unwrap();
    let created_at = wall_ms() - 60_000;
    let id = MeetingId::with_suffix(created_at, 0x0abc).into_string();
    let dir = meeting_dir(&h.data(), &id);
    std::fs::create_dir_all(&dir).unwrap();
    let meeting = json!({
        "id": id, "title": "Outside", "createdAt": created_at, "tracks": ["mic"],
        "sources": { "mic": "default-input" }, "screen": "off", "startedBy": "voice",
        "context": null, "retention": "keep", "version": 1
    });
    std::fs::write(
        dir.join("meeting.json"),
        serde_json::to_vec(&meeting).unwrap(),
    )
    .unwrap();
    let timeline = [
        json!({"kind":"session","t":0,"wall":created_at,"session":1,"pid":1,"resumed":false,
            "version":1,"recorder":"0.1.0"}),
        json!({"kind":"segment","t":0,"track":"mic","seq":1,"file":outside.to_string_lossy()}),
        json!({"kind":"segment_end","t":6000,"track":"mic","seq":1,"samples":96_000}),
        json!({"kind":"segment","t":6000,"track":"mic","seq":2,"file":"../../outside.pdf"}),
        json!({"kind":"segment_end","t":12000,"track":"mic","seq":2,"samples":96_000}),
        json!({"kind":"stop","t":12000,"wall":created_at + 12_000,"reason":"user"}),
    ];
    let text: String = timeline.iter().map(|l| format!("{l}\n")).collect();
    std::fs::write(dir.join("timeline.jsonl"), text).unwrap();

    let engine = h.start();
    let control = engine.meeting_control().unwrap();
    // Neither segment names its own file, so nothing was recorded as far as a link goes.
    assert_eq!(
        code_of(control.media_open(&audio(&id, 0, Some(12_000)))),
        ErrorCode::NotFound
    );
    engine.shutdown();
}

/// Stand-in screen media: one frame at 1 s, and one video file whose "clip" is a copy of it.
struct StandInScreen;

const VIDEO: &str = "screen/video/000001.mp4";
const FRAME: &str = "screen/frames/f-000001000.jpg";
const FRAME_AT: u64 = 1000;

fn stand_in_jpeg() -> Vec<u8> {
    let mut bytes = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10];
    bytes.extend_from_slice(b"JFIF\0");
    bytes.extend((0..20_000u32).map(|i| (i % 241) as u8));
    bytes.extend_from_slice(&[0xFF, 0xD9]);
    bytes
}

fn stand_in_mp4() -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&24u32.to_be_bytes());
    bytes.extend_from_slice(b"ftypisom\0\0\x02\0isomiso2");
    bytes.extend_from_slice(&8u32.to_be_bytes());
    bytes.extend_from_slice(b"moov");
    let data: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
    bytes.extend_from_slice(&(8 + data.len() as u32).to_be_bytes());
    bytes.extend_from_slice(b"mdat");
    bytes.extend(data);
    bytes
}

impl ScreenFiles for StandInScreen {
    fn list(&self, meeting_dir: &Path, stopped: bool) -> std::io::Result<Vec<ScreenFile>> {
        let mut files = Vec::new();
        if meeting_dir.join(FRAME).is_file() {
            files.push(ScreenFile {
                path: FRAME.into(),
                kind: ScreenFileKind::Frame,
                closed: true,
            });
        }
        if meeting_dir.join(VIDEO).is_file() {
            files.push(ScreenFile {
                path: VIDEO.into(),
                kind: ScreenFileKind::Video,
                closed: stopped,
            });
        }
        Ok(files)
    }
}

impl ScreenMedia for StandInScreen {
    fn frame_at(&self, _dir: &Path, at: u64) -> std::io::Result<Option<(String, u64)>> {
        Ok((at >= FRAME_AT).then(|| (FRAME.to_string(), FRAME_AT)))
    }

    fn clip_inputs(&self, _dir: &Path, _start: u64, _end: u64) -> std::io::Result<Vec<String>> {
        Ok(vec![VIDEO.into()])
    }

    fn cut(&self, dir: &Path, start: u64, end: u64) -> Result<(PathBuf, u64, u64), ControlError> {
        let clips = dir.join("screen").join("clips");
        std::fs::create_dir_all(&clips).map_err(|e| ControlError::failed(e.to_string()))?;
        let clip = clips.join(format!("c-{start:09}-{end:09}-000001.mp4"));
        std::fs::copy(dir.join(VIDEO), &clip).map_err(|e| ControlError::failed(e.to_string()))?;
        Ok((clip, start, end))
    }

    fn recorded(&self, _dir: &Path) -> (bool, bool) {
        (true, true)
    }
}

fn media_open_for_video_answers_within_50_ms() {
    let mut h = harness("media-video", json!({"meetings_retention": "keep"}));
    h.screen_files = Arc::new(StandInScreen);
    h.screen_media = Arc::new(StandInScreen);
    let fake = fake_s3();
    let engine = h.start();
    connect_bucket(&engine, &fake.endpoint());
    let code = recovery_code(&engine);
    let id = record(&engine, &h.data(), 2000);
    let dir = meeting_dir(&h.data(), &id);
    let video = stand_in_mp4();
    std::fs::create_dir_all(dir.join("screen").join("video")).unwrap();
    std::fs::write(dir.join(VIDEO), &video).unwrap();
    wait_long("the video in the bucket", Duration::from_secs(60), || {
        bucket_kinds(&fake, &code).contains(&"mp4")
    });
    wait_uploaded(&engine);
    std::fs::remove_file(dir.join(VIDEO)).unwrap();

    // The bucket answers slowly; Voice still answers at once.
    fake.faults().stall = Some(Duration::from_secs(2));
    let control = engine.meeting_control().unwrap();
    let args = MediaOpenArgs {
        kind: MediaKind::Video,
        ..audio(&id, 0, Some(10_000))
    };
    let asked = Instant::now();
    let first = control.media_open(&args).unwrap();
    let took = asked.elapsed();
    assert_eq!(first["ready"], false, "{first}");
    assert!(took < Duration::from_millis(50), "media.open took {took:?}");
    let asked = Instant::now();
    let _ = control.status();
    let took = asked.elapsed();
    assert!(took < Duration::from_millis(50), "status took {took:?}");

    let ready = open_ready(&*control, &args);
    assert_eq!(ready["type"], "video/mp4");
    assert_eq!(
        (&ready["start"], &ready["end"]),
        (&json!(0), &json!(10_000))
    );
    assert_eq!(read_all(&*control, &ready, 1 << 20), video);
    assert!(dir.join(VIDEO).is_file(), "the video came back");
    engine.shutdown();
    fake.stop();
}

/// What `media_open_serves_a_frame_and_a_clip` can't reach with a real screen recording: a frame
/// fetched back while the meeting's other media stays, and a clip that went mid-read, on
/// stand-in screen files that run on every platform.
fn media_open_serves_a_frame_and_opens_a_gone_clip_again() {
    let mut h = harness("media-frame", json!({"meetings_retention": "keep"}));
    h.screen_files = Arc::new(StandInScreen);
    h.screen_media = Arc::new(StandInScreen);
    let fake = fake_s3();
    let engine = h.start();
    connect_bucket(&engine, &fake.endpoint());
    let code = recovery_code(&engine);
    let id = record(&engine, &h.data(), 2000);
    let dir = meeting_dir(&h.data(), &id);
    let (jpeg, video) = (stand_in_jpeg(), stand_in_mp4());
    std::fs::create_dir_all(dir.join("screen").join("frames")).unwrap();
    std::fs::create_dir_all(dir.join("screen").join("video")).unwrap();
    std::fs::write(dir.join(FRAME), &jpeg).unwrap();
    std::fs::write(dir.join(VIDEO), &video).unwrap();
    wait_long(
        "the frame and the video in the bucket",
        Duration::from_secs(60),
        || {
            let kinds = bucket_kinds(&fake, &code);
            kinds.contains(&"jpeg") && kinds.contains(&"mp4")
        },
    );
    wait_uploaded(&engine);
    let control = engine.meeting_control().unwrap();
    let frame = |start| MediaOpenArgs {
        kind: MediaKind::Frame,
        ..audio(&id, start, None)
    };

    // A frame on disk is ready at once, at its own time.
    let ready = control.media_open(&frame(1500)).unwrap();
    assert_eq!(
        (
            &ready["ready"],
            &ready["type"],
            &ready["start"],
            &ready["end"]
        ),
        (
            &json!(true),
            &json!("image/jpeg"),
            &json!(FRAME_AT),
            &json!(FRAME_AT)
        ),
        "{ready}"
    );
    assert_eq!(read_all(&*control, &ready, 7_001), jpeg);
    assert_eq!(
        code_of(control.media_open(&frame(500))),
        ErrorCode::NotFound
    );

    // Gone from this computer: the same arguments prepare it again from the bucket.
    std::fs::remove_file(dir.join(FRAME)).unwrap();
    let again = control.media_open(&frame(1500)).unwrap();
    assert_eq!(again["ready"], false, "{again}");
    let back = open_ready(&*control, &frame(1500));
    assert_eq!(read_all(&*control, &back, 1 << 20), jpeg);
    assert!(dir.join(FRAME).is_file(), "the frame came back");

    // A clip removed mid-read answers not_found; opening it again cuts it again.
    let args = MediaOpenArgs {
        kind: MediaKind::Video,
        ..audio(&id, 0, Some(10_000))
    };
    let clip = open_ready(&*control, &args);
    let media = clip["media"].as_str().unwrap().to_string();
    control.media_read(&media, 0, 1000).unwrap();
    let clips: Vec<PathBuf> = std::fs::read_dir(dir.join("screen").join("clips"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    assert_eq!(clips.len(), 1, "{clips:?}");
    std::fs::remove_file(&clips[0]).unwrap();
    assert_eq!(
        code_of(control.media_read(&media, 1000, 1000)),
        ErrorCode::NotFound
    );
    let reopened = open_ready(&*control, &args);
    assert_ne!(reopened["media"], clip["media"], "a new preparation");
    assert_eq!(read_all(&*control, &reopened, 1 << 20), video);

    // With sync off, a frame that isn't here isn't available.
    engine
        .settings_set("storage.sync.enabled", json!(false))
        .unwrap();
    std::fs::remove_file(dir.join(FRAME)).unwrap();
    assert_eq!(
        code_of(control.media_open(&frame(1700))),
        ErrorCode::NotAvailable
    );
    engine.shutdown();
    fake.stop();
}

// Restore ------------------------------------------------------------------------------------

fn a_restored_meeting_reaches_the_bridge() {
    let fake = fake_s3();
    let a = harness("restore-a", json!({"meetings_retention": "keep"}));
    let engine_a = a.start();
    connect_bucket(&engine_a, &fake.endpoint());
    let code = recovery_code(&engine_a);
    let id = record(&engine_a, &a.data(), 3000);
    wait_uploaded(&engine_a);
    let snapshot_a = engine_a.meeting_control().unwrap().get(&id).unwrap();
    assert!(!snapshot_a["passages"].as_array().unwrap().is_empty());
    engine_a.shutdown();

    // Another data folder with the saved key and the same bucket: the finished meeting comes by
    // itself, as text.
    let b = harness("restore-b", json!({"meetings_retention": "keep"}));
    let engine_b = b.start();
    // A cloud provider this computer hasn't agreed to: a meeting transcribed elsewhere doesn't wait
    // for it, because nothing goes to the provider.
    engine_b
        .settings_save_provider(json!({"target": "meetings", "provider": "mistral", "endpoint": "https://api.mistral.ai/v1/audio/transcriptions", "model": "voxtral-mini-latest", "apiKey": "sk-test-not-a-real-key", "consent": false}))
        .unwrap();
    engine_b
        .settings_sync_key("import", Some(code.clone()))
        .unwrap();
    connect_bucket(&engine_b, &fake.endpoint());
    wait_done(&b.data(), &id);
    let snapshot_b = engine_b.meeting_control().unwrap().get(&id).unwrap();
    for part in ["passages", "speakers"] {
        assert_eq!(snapshot_b[part], snapshot_a[part], "{part}");
    }
    assert_eq!(
        snapshot_b["meeting"]["title"],
        snapshot_a["meeting"]["title"]
    );
    for file in ["meeting.json", "timeline.jsonl"] {
        assert_eq!(
            std::fs::read(meeting_dir(&b.data(), &id).join(file)).unwrap(),
            std::fs::read(meeting_dir(&a.data(), &id).join(file)).unwrap(),
            "{file}"
        );
    }
    assert!(!meeting_dir(&b.data(), &id).join("audio").exists());
    // The audio comes back when a link needs it.
    let control = engine_b.meeting_control().unwrap();
    let wav = read_all(
        &*control,
        &open_ready(&*control, &audio(&id, 0, Some(20_000))),
        1 << 20,
    );
    let dir_a = meeting_dir(&a.data(), &id);
    assert_eq!(wav, expected_mix(&dir_a, 0, recorded_end(&dir_a)));
    let state = sync_state(&engine_b);
    assert!(state["pull"]["at"].is_u64(), "{state}");
    assert_eq!(state["restore"]["available"], 0, "{state}");
    // A restore from Settings finds nothing left to bring.
    let list = engine_b.settings_sync_restore("list").unwrap();
    assert_eq!(list["meetings"], json!([]), "{list}");
    engine_b.shutdown();
    fake.stop();
}

/// The events of `id` in a data folder's event log: (event, data), oldest first.
fn events_of(data: &Path, id: &str) -> Vec<(String, Value)> {
    EventLog::open(data)
        .unwrap()
        .after(0)
        .unwrap()
        .into_iter()
        .filter(|s| s.meeting.as_deref() == Some(id))
        .map(|s| (s.event, s.data))
        .collect()
}

/// Two computers with the same bucket at once: newer text and a deletion on one reach the other,
/// and Rukoo on the other hears of them through its event log.
fn changes_and_deletions_reach_the_other_computer() {
    let fake = fake_s3();
    let a = harness("pull-a", json!({"meetings_retention": "keep"}));
    let engine_a = a.start();
    connect_bucket(&engine_a, &fake.endpoint());
    let code = recovery_code(&engine_a);
    let id = record(&engine_a, &a.data(), 3000);
    wait_uploaded(&engine_a);

    let b = harness("pull-b", json!({"meetings_retention": "keep"}));
    let engine_b = b.start();
    engine_b
        .settings_sync_key("import", Some(code.clone()))
        .unwrap();
    connect_bucket(&engine_b, &fake.endpoint());
    wait_done(&b.data(), &id);
    let passages = engine_b.meeting_control().unwrap().get(&id).unwrap()["passages"]
        .as_array()
        .unwrap()
        .clone();
    assert!(passages.len() >= 2, "{passages:?}");
    let kept = passages[0]["id"].as_str().unwrap().to_string();
    let dropped = passages[passages.len() - 1]["id"]
        .as_str()
        .unwrap()
        .to_string();

    // B had changed the same passage on its own, to a higher revision: what A's newer text says
    // still has to win in Rukoo there.
    let stale_revision = passages[0]["revision"].as_u64().unwrap() + 5;
    {
        let first = &passages[0];
        let mut stale = first.clone();
        stale["text"] = "Stale words from this computer".into();
        stale["revision"] = (first["revision"].as_u64().unwrap() + 5).into();
        EventLog::open(&b.data())
            .unwrap()
            .append("passage", Some(&id), stale)
            .unwrap();
    }
    // Newer text on A, as another transcription would leave it: one passage reworded, one gone.
    {
        let db =
            rusqlite::Connection::open(meeting_dir(&a.data(), &id).join("transcript.db")).unwrap();
        db.execute(
            "UPDATE passages SET text = 'Reworded on the other computer', revision = revision + 1 \
             WHERE id = ?1",
            [&kept],
        )
        .unwrap();
        db.execute("DELETE FROM passages WHERE id = ?1", [&dropped])
            .unwrap();
    }
    wait_long("B hears of the newer text", Duration::from_secs(60), || {
        let events = events_of(&b.data(), &id);
        // Its revision is lower than the one B logged: it goes out with the next revision after
        // that one, which any Rukoo takes, and the user's correction of it stays.
        let last = events
            .iter()
            .rev()
            .find(|(e, d)| e == "passage" && d["id"] == kept.as_str());
        let reworded = last.is_some_and(|(_, d)| {
            d["text"] == "Reworded on the other computer"
                && d["revision"].as_u64() == Some(stale_revision + 1)
        }) && !events
            .iter()
            .any(|(e, d)| e == "passage.removed" && d["id"] == kept.as_str());
        let removed = events
            .iter()
            .any(|(e, d)| e == "passage.removed" && d["id"] == dropped.as_str());
        reworded && removed
    });
    let snapshot = engine_b.meeting_control().unwrap().get(&id).unwrap();
    let ids: Vec<&str> = snapshot["passages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["id"].as_str().unwrap())
        .collect();
    assert!(!ids.contains(&dropped.as_str()), "{snapshot}");
    // A Rukoo that asks for the whole meeting gets the newer words too.
    let words = snapshot["passages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == kept.as_str())
        .map(|p| p["text"].clone());
    assert_eq!(
        words,
        Some(json!("Reworded on the other computer")),
        "{snapshot}"
    );
    // B's transcript carries that revision now, and goes up once; A takes it and nothing more goes
    // back and forth.
    wait_long("A takes B's revision", Duration::from_secs(60), || {
        events_of(&a.data(), &id).iter().rev().any(|(e, d)| {
            e == "passage"
                && d["id"] == kept.as_str()
                && d["revision"].as_u64() == Some(stale_revision + 1)
                && d["text"] == "Reworded on the other computer"
        })
    });
    let manifests = |fake: &FakeS3| {
        fake.log()
            .iter()
            .filter(|l| l.op == Op::Put && l.key.ends_with("/manifest"))
            .count()
    };
    wait_uploaded(&engine_a);
    wait_uploaded(&engine_b);
    std::thread::sleep(Duration::from_secs(3));
    let before = manifests(&fake);
    std::thread::sleep(Duration::from_secs(5));
    assert_eq!(manifests(&fake), before, "the meeting went back and forth");

    // A deletes it: B removes it as a user deletion, so Rukoo there purges its notes too.
    engine_a.meeting_control().unwrap().delete(&id).unwrap();
    wait_long("B deletes the meeting", Duration::from_secs(60), || {
        events_of(&b.data(), &id)
            .iter()
            .any(|(e, d)| e == "meeting.removed" && d["reason"] == "user")
    });
    assert!(!meeting_dir(&b.data(), &id).exists());
    engine_a.shutdown();
    engine_b.shutdown();
    fake.stop();
}

// Media on request ----------------------------------------------------------------------------

/// A stand-in JPEG of about 8 KB, different for each `n`.
fn small_jpeg(n: u8) -> Vec<u8> {
    let mut bytes = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10];
    bytes.extend_from_slice(b"JFIF\0");
    bytes.extend((0..8_000u32).map(|i| (i as u8).wrapping_mul(n)));
    bytes.extend_from_slice(&[0xFF, 0xD9]);
    bytes
}

/// Frames at these meeting times, with their screen journal, as a screen recording leaves them.
const SHOTS: [u64; 3] = [500, 1500, 2500];

fn shot(at: u64) -> String {
    voice_screen_files::paths::frame_file(&voice_screen_files::paths::frame_id(at))
}

fn write_shots(dir: &Path, end: u64) {
    std::fs::create_dir_all(dir.join("screen").join("frames")).unwrap();
    let mut lines = vec![ScreenLine::Mode {
        t: 0,
        id: "mode-1".into(),
        mode: "frames".into(),
        reason: "user".into(),
    }];
    for (i, at) in SHOTS.iter().enumerate() {
        std::fs::write(dir.join(shot(*at)), small_jpeg(i as u8 + 3)).unwrap();
        lines.push(ScreenLine::Frame {
            t: *at,
            id: voice_screen_files::paths::frame_id(*at),
            file: shot(*at),
            width: 1280,
            height: 720,
            text: format!("Slide {}", i + 1),
            ocr: "ok".into(),
            language: None,
        });
    }
    lines.push(ScreenLine::Stop {
        t: end,
        reason: "meeting".into(),
    });
    let text: String = lines
        .iter()
        .map(|l| serde_json::to_string(l).unwrap() + "\n")
        .collect();
    std::fs::write(dir.join("screen").join("journal.jsonl"), text).unwrap();
}

/// The media files of a meeting folder on disk, relative and sorted.
fn media_files(dir: &Path) -> Vec<String> {
    let mut files: Vec<String> = voice_meetings::MediaPart::ORDER
        .iter()
        .flat_map(|part| part.files(dir))
        .collect();
    files.sort();
    files
}

/// A meeting recorded on computer A comes to B as text. On B its frame images come back from the
/// bucket on request (`frame.get` answers `pending`, then the image) and ahead of time
/// (`media.prefetch`), what came back stays within the cache limit, least recently used going
/// first, while media B recorded itself and never uploaded stays; and a meeting kept on this
/// computer downloads everything, keeps it from the limit and survives a restart.
fn a_pulled_meeting_s_media_comes_on_request_within_the_cache_limit() {
    let fake = fake_s3();
    let a = harness("keep-a", json!({"meetings_retention": "keep"}));
    let engine_a = a.start();
    connect_bucket(&engine_a, &fake.endpoint());
    let code = recovery_code(&engine_a);
    let id = record(&engine_a, &a.data(), 3000);
    write_shots(&meeting_dir(&a.data(), &id), 3000);
    wait_long("the frames in the bucket", Duration::from_secs(60), || {
        bucket_kinds(&fake, &code)
            .iter()
            .filter(|k| **k == "jpeg")
            .count()
            == SHOTS.len()
    });
    wait_uploaded(&engine_a);
    engine_a.shutdown();

    // B: a GB of the cache limit is 5,000 bytes here, so the default limit, 5 GB, is 25,000.
    let mut b = harness("keep-b", json!({"meetings_retention": "keep"}));
    b.sync_timing.cache_gb = 5_000;
    let engine_b = b.start();
    engine_b
        .settings_sync_key("import", Some(code.clone()))
        .unwrap();
    connect_bucket(&engine_b, &fake.endpoint());
    wait_done(&b.data(), &id);
    let dir = meeting_dir(&b.data(), &id);
    assert!(media_files(&dir).is_empty(), "the meeting came as text");
    let control = engine_b.meeting_control().unwrap();

    // frame.get answers at once with pending, then with the image.
    let first = control.frame(&id, 1600).unwrap();
    assert_eq!(
        (&first["image"], &first["pending"], &first["frame"]["text"]),
        (&Value::Null, &json!(true), &json!("Slide 2")),
        "{first}"
    );
    let mut image = Value::Null;
    wait_long(
        "the frame image from the bucket",
        Duration::from_secs(30),
        || {
            let reply = control.frame(&id, 1600).unwrap();
            image = reply["image"].clone();
            !image.is_null()
        },
    );
    let data = base64::engine::general_purpose::STANDARD
        .decode(image["data"].as_str().unwrap())
        .unwrap();
    assert_eq!(data, small_jpeg(4));

    // media.prefetch brings the others in the background.
    assert_eq!(control.prefetch_frames(&id).unwrap(), json!({}));
    wait_long("the frames fetched ahead", Duration::from_secs(30), || {
        SHOTS.iter().all(|at| dir.join(shot(*at)).is_file())
    });
    // An agent's link reads the first frame where it is; then the others are used, the last one
    // last.
    let link = MediaOpenArgs {
        kind: MediaKind::Frame,
        ..audio(&id, 500, None)
    };
    assert_eq!(control.media_open(&link).unwrap()["ready"], true);
    std::thread::sleep(Duration::from_millis(20));
    assert!(!control.frame(&id, 1600).unwrap()["image"].is_null());
    std::thread::sleep(Duration::from_millis(20));
    assert!(!control.frame(&id, 2600).unwrap()["image"].is_null());

    // B records a meeting the bucket never gets.
    fake.faults().refuse = true;
    let own = record(&engine_b, &b.data(), 2000);
    let own_media = media_files(&meeting_dir(&b.data(), &own));
    assert!(!own_media.is_empty());

    // 2 GB is 10,000 bytes here, room for one frame. Use a moment ago keeps nothing: the frames
    // nobody reads go, the one used last too, and the one the link has open stays, as does
    // everything B recorded itself.
    engine_b
        .settings_set("storage.sync.cache", json!("gb2"))
        .unwrap();
    wait_long("the cache limit", Duration::from_secs(30), || {
        !dir.join(shot(1500)).exists() && !dir.join(shot(2500)).exists()
    });
    assert!(
        dir.join(shot(500)).is_file(),
        "the frame a link reads stays"
    );
    assert_eq!(media_files(&meeting_dir(&b.data(), &own)), own_media);
    // Fetching ahead stops at the limit rather than going past it.
    fake.faults().refuse = false;
    assert_eq!(control.prefetch_frames(&id).unwrap(), json!({}));
    std::thread::sleep(Duration::from_secs(2));
    assert!(
        !dir.join(shot(1500)).exists() && !dir.join(shot(2500)).exists(),
        "nothing fetched ahead past the limit"
    );
    fake.faults().refuse = true;
    wait_long(
        "Settings to show the cache",
        Duration::from_secs(30),
        || engine_b.settings_state()["storage"]["cacheBytes"] == json!(small_jpeg(5).len()),
    );
    fake.faults().refuse = false;

    // Keep on this computer: everything comes down and the limit leaves it alone.
    let kept = control.keep_media(&id, Some(true)).unwrap();
    assert_eq!(kept["keep"], true, "{kept}");
    wait_long("the kept meeting's media", Duration::from_secs(60), || {
        let state = control.keep_media(&id, None).unwrap();
        state["have"] == state["total"]
    });
    let all = media_files(&dir);
    assert!(all.iter().any(|p| p.starts_with("audio/")), "{all:?}");
    assert!(SHOTS.iter().all(|at| all.contains(&shot(*at))), "{all:?}");
    // One file goes missing while Voice is closed; the choice and the download outlive a restart.
    std::fs::remove_file(dir.join(&all[0])).unwrap();
    engine_b.shutdown();
    let engine_b = b.start();
    let control = engine_b.meeting_control().unwrap();
    wait_long(
        "the kept meeting complete again",
        Duration::from_secs(60),
        || {
            let state = control.keep_media(&id, None).unwrap();
            state["keep"] == true && state["have"] == state["total"]
        },
    );
    assert_eq!(
        media_files(&dir),
        all,
        "the cache limit left the kept meeting alone"
    );

    // Not kept any more: the limit applies to it again.
    assert_eq!(control.keep_media(&id, Some(false)).unwrap()["keep"], false);
    wait_long(
        "the limit on the meeting again",
        Duration::from_secs(30),
        || media_files(&dir).len() < all.len(),
    );
    assert_eq!(media_files(&meeting_dir(&b.data(), &own)), own_media);

    // Deleting the meeting drops the choice.
    control.keep_media(&id, Some(true)).unwrap();
    control.delete(&id).unwrap();
    assert_eq!(code_of(control.keep_media(&id, None)), ErrorCode::NotFound);
    engine_b.shutdown();
    fake.stop();
}

/// A passage that spans two segments of a meeting from the bucket: the player's `piece` of it is
/// ready once the segments its start falls in are here, while the next one still comes, and ends
/// where they end; the rest follows. A link's `media.open` still waits for the whole range.
fn a_passage_from_the_bucket_starts_after_its_first_segment() {
    let fake = fake_s3();
    let a = harness("piece-a", json!({"meetings_retention": "keep"}));
    let engine_a = a.start();
    connect_bucket(&engine_a, &fake.endpoint());
    let code = recovery_code(&engine_a);
    let id = record(&engine_a, &a.data(), 3000);
    wait_uploaded(&engine_a);
    engine_a.shutdown();
    let recorded = meeting_dir(&a.data(), &id);

    let b = harness("piece-b", json!({"meetings_retention": "keep"}));
    let engine_b = b.start();
    engine_b
        .settings_sync_key("import", Some(code.clone()))
        .unwrap();
    connect_bucket(&engine_b, &fake.endpoint());
    wait_done(&b.data(), &id);
    let control = engine_b.meeting_control().unwrap();
    // An earlier clip brought the first second back.
    open_ready(&*control, &audio(&id, 200, Some(600)));
    let piece = |start, end| MediaOpenArgs {
        piece: true,
        ..audio(&id, start, Some(end))
    };

    // The bucket holds every answer for 6 s: the first piece doesn't need it.
    fake.faults().stall = Some(Duration::from_secs(6));
    let asked = Instant::now();
    let first = open_ready(&*control, &piece(700, 1700));
    assert!(
        asked.elapsed() < Duration::from_secs(3),
        "the first piece took {:?}",
        asked.elapsed()
    );
    let boundary = first["end"].as_u64().unwrap();
    assert!(boundary > 700 && boundary < 1700, "{first}");
    assert_eq!(first["start"], 700);
    assert_eq!(first["more"], true, "audio follows the piece: {first}");
    assert_eq!(
        read_all(&*control, &first, 1 << 20),
        expected_mix(&recorded, 700, boundary)
    );

    // The rest waits for the next segment, which comes once the bucket answers.
    let rest = piece(boundary, 1700);
    assert_eq!(control.media_open(&rest).unwrap()["ready"], false);
    fake.faults().stall = None;
    let second = open_ready(&*control, &rest);
    assert_eq!(
        (&second["start"], &second["end"]),
        (&json!(boundary), &json!(1700))
    );
    assert_eq!(
        read_all(&*control, &second, 1 << 20),
        expected_mix(&recorded, boundary, 1700)
    );
    assert!(second.get("more").is_none(), "{second}");

    // A link gets the whole range in one file, as before.
    let whole = open_ready(&*control, &audio(&id, 700, Some(1700)));
    assert_eq!(whole["end"], 1700);
    assert!(whole.get("more").is_none(), "{whole}");
    assert_eq!(
        read_all(&*control, &whole, 1 << 20),
        expected_mix(&recorded, 700, 1700)
    );

    // The recorder starts a segment before the previous one ends when it corrects clock drift:
    // here the first segment of each track still in the bucket starts 200 ms early. The mix keeps
    // the overlap in the earlier segment, so a piece across that boundary needs only the
    // segments on this computer.
    let here = meeting_dir(&b.data(), &id);
    let (before, overlap) = overlap_next_missing(&here, 200);
    let (from, to) = (
        before.iter().min().unwrap() - 100,
        before.iter().max().unwrap() + 100,
    );
    fake.faults().stall = Some(Duration::from_secs(6));
    let asked = Instant::now();
    let early = open_ready(&*control, &piece(from, to));
    assert!(
        asked.elapsed() < Duration::from_secs(3),
        "the piece over overlapping segments took {:?}",
        asked.elapsed()
    );
    assert_eq!(early["end"], *before.iter().min().unwrap(), "{early}");
    assert_eq!(early["more"], true, "{early}");
    assert!(overlap.iter().all(|file| !here.join(file).is_file()));
    assert_eq!(
        read_all(&*control, &early, 1 << 20),
        expected_mix(&here, from, early["end"].as_u64().unwrap())
    );
    fake.faults().stall = None;

    // The last passage runs past the recording: the player follows `more` from piece to piece,
    // and the last one ends where the audio ends, without `more`.
    let past = to + 10_000;
    let mut at = early["end"].as_u64().unwrap();
    let mut last = early;
    while last.get("more").is_some() {
        assert_eq!(last["more"], true, "{last}");
        last = open_ready(&*control, &piece(at, past));
        assert_eq!(last["start"], at, "{last}");
        at = last["end"].as_u64().unwrap();
    }
    assert_eq!(at, recorded_end(&here));
    assert!(at < past);
    assert_eq!(
        code_of(control.media_open(&piece(at, past))),
        ErrorCode::NotFound,
        "nothing is recorded after the last piece"
    );
    engine_b.shutdown();
    fake.stop();
}

/// Moves the first segment of each track that isn't on this computer `ms` earlier, into the
/// segment before it, in the meeting's timeline. The ends of the segments before, in ms, and the
/// files of the moved ones.
fn overlap_next_missing(dir: &Path, ms: u64) -> (Vec<u64>, Vec<String>) {
    let path = dir.join("timeline.jsonl");
    let mut lines: Vec<Value> = std::fs::read_to_string(&path)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    let ended = |lines: &[Value], track: &str, seq: u64| {
        lines
            .iter()
            .find(|l| l["kind"] == "segment_end" && l["track"] == track && l["seq"] == seq)
            .and_then(|l| l["samples"].as_u64())
            .unwrap()
    };
    let (mut before, mut moved) = (Vec::new(), Vec::new());
    for track in ["mic", "call"] {
        let mut segments: Vec<(usize, u64, u64, String)> = lines
            .iter()
            .enumerate()
            .filter(|(_, l)| l["kind"] == "segment" && l["track"] == track)
            .map(|(i, l)| {
                let seq = l["seq"].as_u64().unwrap();
                (
                    i,
                    seq,
                    l["t"].as_u64().unwrap(),
                    l["file"].as_str().unwrap().to_owned(),
                )
            })
            .collect();
        segments.sort_by_key(|s| s.1);
        let n = segments
            .iter()
            .position(|s| !dir.join(&s.3).is_file())
            .unwrap_or_else(|| panic!("every {track} segment is here"));
        assert!(n > 0, "the first {track} segment isn't here");
        let p = &segments[n - 1];
        let end = p.2 + ended(&lines, track, p.1).div_ceil(16);
        before.push(end);
        lines[segments[n].0]["t"] = json!(end - ms);
        moved.push(segments[n].3.clone());
    }
    let text: String = lines.iter().map(|l| format!("{l}\n")).collect();
    std::fs::write(&path, text).unwrap();
    (before, moved)
}

// The real screen recording --------------------------------------------------------------------

/// The screen process's synthetic screen, a new slide every second, with Microsoft's software
/// encoder for video, as in tests/screen.rs.
const SYNTHETIC_SCREEN: &str =
    "synthetic:1280x720,change-every=1000,text=Slide,no-hardware,software-encoder";

/// `harness` that also records the screen: this binary as the screen process on the synthetic
/// screen, and Voice's default screen mode `video`.
fn screen_harness(name: &str, retention: &str) -> Harness {
    let mut h = harness(
        name,
        json!({"meetings_retention": retention, "meetings_screen": "video"}),
    );
    h.screen_exe = std::env::current_exe().unwrap();
    h.screen_timing = ScreenTiming {
        poll: Duration::from_millis(100),
        start_timeout: Duration::from_secs(20),
        backoff: vec![Duration::from_millis(100), Duration::from_millis(200)],
        stable_after: Duration::from_secs(60),
        ping_failures: 3,
        handshake: Duration::from_millis(500),
        end_wait: Duration::from_secs(10),
        reconnect: Duration::from_secs(5),
    };
    h.test_screen = Some(SYNTHETIC_SCREEN.into());
    h
}

fn journal(data: &Path, id: &str) -> Vec<ScreenLine> {
    voice_screen_files::journal::read_all(&meeting_dir(data, id)).unwrap_or_default()
}

fn frames_journaled(data: &Path, id: &str) -> usize {
    journal(data, id)
        .iter()
        .filter(|l| matches!(l, ScreenLine::Frame { .. }))
        .count()
}

/// Whether a decrypted object is the screen journal: its first line is the screen process's
/// `session`, which names its clock `anchor`; the recorder's doesn't.
fn is_journal(plain: &[u8]) -> bool {
    let text = String::from_utf8_lossy(plain);
    text.lines()
        .next()
        .and_then(|l| serde_json::from_str::<Value>(l).ok())
        .is_some_and(|l| l["kind"] == "session" && l.get("anchor").is_some())
}

/// The first time the fake took an upload of an object, in wall ms.
fn first_upload(fake: &FakeS3, object: &str) -> Option<u64> {
    fake.log()
        .iter()
        .filter(|l| matches!(l.op, Op::Put | Op::UploadPart) && l.status < 300)
        .filter(|l| l.key.ends_with(object))
        .map(|l| l.at)
        .min()
}

/// Records `before` ms, pauses for `paused` ms, resumes, records `after` ms more, and stops: two
/// video files, the first ended by the pause. Waits until the meeting is done.
fn record_with_pause(engine: &Engine, data: &Path, before: u64, paused: u64, after: u64) -> String {
    let id = engine.start_meeting().unwrap();
    wait_recorded(data, &id, before);
    wait_long(
        "a frame in the screen journal",
        Duration::from_secs(30),
        || frames_journaled(data, &id) > 0,
    );
    let control = engine.meeting_control().unwrap();
    control.pause(&id).unwrap();
    std::thread::sleep(Duration::from_millis(paused));
    control.resume(&id).unwrap();
    wait_long("the second video file", Duration::from_secs(30), || {
        journal(data, &id)
            .iter()
            .any(|l| matches!(l, ScreenLine::Video { seq: 2, .. }))
    });
    std::thread::sleep(Duration::from_millis(after));
    engine.stop_meeting(StopReason::User).unwrap();
    wait_done(data, &id);
    id
}

/// Frames go up while the meeting records, after audio; video only after the timeline's stop and
/// its `video_end`; the journal after its own `stop`; the clips and `screen.json` never (contract
/// 2.1, spec RUK-110 2.8).
fn screen_files_upload_by_their_rules() {
    if !cfg!(any(windows, target_os = "macos")) {
        println!("skipped: the screen process records on Windows only");
        return;
    }
    let h = screen_harness("sync-screen", "keep");
    let fake = fake_s3();
    let engine = h.start();
    connect_bucket(&engine, &fake.endpoint());
    let code = recovery_code(&engine);
    let id = engine.start_meeting().unwrap();
    let dir = meeting_dir(&h.data(), &id);
    wait_recorded(&h.data(), &id, 3000);
    wait_long(
        "frames in the bucket while it records",
        Duration::from_secs(60),
        || bucket_kinds(&fake, &code).contains(&"jpeg"),
    );
    let screen_json =
        std::fs::read(dir.join("screen").join("screen.json")).expect("a live screen.json");
    let live = decrypt_all(&fake, &code);
    assert!(
        live.iter().any(|(_, p)| support::kind_of(p) == "audio"),
        "audio goes up with the frames"
    );
    assert!(
        !live.iter().any(|(_, p)| support::kind_of(p) == "mp4"),
        "no video while the meeting records"
    );
    assert!(
        !live.iter().any(|(_, p)| is_journal(p)),
        "the journal waits for its stop"
    );
    let stopped_at = wall_ms();
    engine.stop_meeting(StopReason::User).unwrap();
    wait_done(&h.data(), &id);
    // On a Mac: `done` follows the journal's `stop`, so the closed files are final. Sync hears of
    // `done` at the engine's next look at the event log, up to a second later, and until that
    // scan Settings can say idle while the last frame and the journal aren't queued yet.
    #[cfg(target_os = "macos")]
    let closed = voice_screen_files::media::closed_files(&dir).unwrap();
    #[cfg(target_os = "macos")]
    wait_long(
        "every closed screen file in the bucket",
        Duration::from_secs(60),
        || {
            let objects = decrypt_all(&fake, &code);
            closed.iter().all(|(rel, _)| {
                let bytes = std::fs::read(dir.join(rel)).unwrap();
                objects.iter().any(|(_, plain)| *plain == bytes)
            })
        },
    );
    wait_uploaded(&engine);

    #[cfg(not(target_os = "macos"))]
    let closed = voice_screen_files::media::closed_files(&dir).unwrap();
    let objects = decrypt_all(&fake, &code);
    let object_of = |rel: &str| {
        let bytes = std::fs::read(dir.join(rel)).unwrap();
        objects
            .iter()
            .find(|(_, plain)| *plain == bytes)
            .map(|(name, _)| name.clone())
    };
    let mut frames_before_stop = 0;
    let mut videos = 0;
    for (rel, kind) in &closed {
        let object = object_of(rel).unwrap_or_else(|| panic!("{rel} isn't in the bucket"));
        let first = first_upload(&fake, &object).expect("an upload");
        match kind {
            voice_screen_files::media::ScreenFileKind::Video => {
                videos += 1;
                assert!(first >= stopped_at, "{rel} went up before the stop");
            }
            voice_screen_files::media::ScreenFileKind::Frame if first < stopped_at => {
                frames_before_stop += 1
            }
            _ => {}
        }
    }
    assert!(videos >= 1, "the meeting recorded video: {closed:?}");
    assert!(frames_before_stop >= 1);
    assert!(
        closed
            .iter()
            .any(|(_, k)| *k == voice_screen_files::media::ScreenFileKind::Journal),
        "the journal is closed after the stop"
    );
    assert_eq!(objects.iter().filter(|(_, p)| is_journal(p)).count(), 1);
    assert!(!dir.join("screen").join("screen.json").exists());
    assert!(
        !objects.iter().any(|(_, p)| *p == screen_json),
        "screen.json never goes up"
    );

    // A clip cut for Rukoo stays on this computer.
    let control = engine.meeting_control().unwrap();
    let deadline = Instant::now() + Duration::from_secs(4);
    let mut clip = control.clip(&id, 0, 2000, deadline).unwrap();
    wait_long("a cut clip", Duration::from_secs(60), || {
        if clip["clips"].as_array().is_some_and(|c| !c.is_empty()) {
            return true;
        }
        clip = control
            .clip(&id, 0, 2000, Instant::now() + Duration::from_secs(4))
            .unwrap();
        false
    });
    let clip_path = PathBuf::from(clip["clips"][0]["path"].as_str().unwrap());
    let clip_bytes = std::fs::read(&clip_path).unwrap();
    engine
        .settings_set("storage.sync.enabled", json!(true))
        .unwrap();
    std::thread::sleep(Duration::from_secs(3));
    wait_uploaded(&engine);
    assert!(
        !decrypt_all(&fake, &code)
            .iter()
            .any(|(_, p)| *p == clip_bytes),
        "a clip never goes up"
    );
    engine.shutdown();
    fake.stop();
}

/// A frame and a stretch of video through `media.open` and `media.read`, from this computer and
/// again after retention removed them and sync fetched them back. A range across a pause gives
/// one stretch, with the shorter end (contract 2.3).
fn media_open_serves_a_frame_and_a_clip() {
    if !cfg!(any(windows, target_os = "macos")) {
        println!("skipped: the screen process records on Windows only");
        return;
    }
    let h = screen_harness("media-screen", "after_transcription");
    let fake = fake_s3();
    let engine = h.start();
    connect_bucket(&engine, &fake.endpoint());
    // Nothing reaches the bucket yet, so retention holds the media while the test reads it.
    fake.faults().refuse = true;
    let id = record_with_pause(&engine, &h.data(), 3000, 1500, 2500);
    let dir = meeting_dir(&h.data(), &id);
    let lines = journal(&h.data(), &id);
    let pause_end = lines
        .iter()
        .find_map(|l| match l {
            ScreenLine::VideoEnd {
                seq: 1, t, reason, ..
            } => {
                assert_eq!(reason, "pause");
                Some(*t)
            }
            _ => None,
        })
        .expect("the first video file ends at the pause");
    let stop = lines
        .iter()
        .find_map(|l| match l {
            ScreenLine::Stop { t, .. } => Some(*t),
            _ => None,
        })
        .unwrap();
    let frame = lines
        .iter()
        .find_map(|l| match l {
            ScreenLine::Frame { t, file, .. } => Some((*t, file.clone())),
            _ => None,
        })
        .unwrap();
    let jpeg = std::fs::read(dir.join(&frame.1)).unwrap();
    let control = engine.meeting_control().unwrap();
    let frame_args = MediaOpenArgs {
        kind: MediaKind::Frame,
        ..audio(&id, frame.0 + 10, None)
    };
    let video_args = MediaOpenArgs {
        kind: MediaKind::Video,
        ..audio(&id, 0, Some(stop))
    };

    // From this computer: the frame at once, the video once it is cut.
    let ready = control.media_open(&frame_args).unwrap();
    assert_eq!(ready["ready"], true, "{ready}");
    assert_eq!(
        (&ready["type"], &ready["start"]),
        (&json!("image/jpeg"), &json!(frame.0))
    );
    assert_eq!(read_all(&*control, &ready, 1 << 20), jpeg);
    let video = open_ready(&*control, &video_args);
    assert_eq!(video["type"], "video/mp4");
    let end = video["end"].as_u64().unwrap();
    assert!(
        end < stop && end <= pause_end + 100,
        "one stretch, ending at the pause ({pause_end}), not at the stop ({stop}): {video}"
    );
    let clip = read_all(&*control, &video, 1 << 20);
    assert_eq!(&clip[4..8], b"ftyp");

    // Retention removes the media once it is in the bucket; a link fetches it back.
    fake.faults().refuse = false;
    wait_uploaded(&engine);
    let frames_dir = dir.join("screen").join("frames");
    let video_dir = dir.join("screen").join("video");
    wait_long(
        "retention to remove the screen media",
        Duration::from_secs(60),
        || !frames_dir.exists() && !video_dir.exists(),
    );
    assert!(
        dir.join("screen").join("journal.jsonl").is_file(),
        "the journal stays"
    );
    let back = open_ready(&*control, &frame_args);
    assert_eq!(
        read_all(&*control, &back, 7_001),
        jpeg,
        "the frame came back from the bucket"
    );
    let again = open_ready(&*control, &video_args);
    assert_eq!(again["end"], video["end"], "the same stretch");
    assert_eq!(
        read_all(&*control, &again, 1 << 20),
        clip,
        "the same clip from the fetched video"
    );
    engine.shutdown();
    fake.stop();
}

/// A meeting whose video hasn't reached the bucket keeps `screen/video`, with its frames and audio,
/// past its retention; once it uploaded, the sweep removes them and keeps the journal (contract 2.6).
fn retention_holds_screen_media() {
    if !cfg!(any(windows, target_os = "macos")) {
        println!("skipped: the screen process records on Windows only");
        return;
    }
    let h = screen_harness("retention-screen", "after_transcription");
    let fake = fake_s3();
    let engine = h.start();
    connect_bucket(&engine, &fake.endpoint());
    let code = recovery_code(&engine);
    let id = engine.start_meeting().unwrap();
    wait_recorded(&h.data(), &id, 3000);
    wait_long("frames in the bucket", Duration::from_secs(60), || {
        bucket_kinds(&fake, &code).contains(&"jpeg")
    });
    // The bucket stops taking uploads before the video can go up.
    fake.faults().refuse = true;
    engine.stop_meeting(StopReason::User).unwrap();
    wait_done(&h.data(), &id);
    let dir = meeting_dir(&h.data(), &id);
    // The engine sweeps right after it reads `done`, within a second or two.
    std::thread::sleep(Duration::from_millis(3000));
    let video = dir.join("screen").join("video");
    assert!(video.is_dir(), "video that isn't in the bucket stays");
    assert!(dir.join("screen").join("frames").is_dir());
    assert!(dir.join("audio").is_dir());
    assert!(!bucket_kinds(&fake, &code).contains(&"mp4"));

    fake.faults().refuse = false;
    wait_long("the uploaded media to go", Duration::from_secs(60), || {
        !video.exists()
            && !dir.join("screen").join("frames").exists()
            && !dir.join("audio").exists()
    });
    assert!(bucket_kinds(&fake, &code).contains(&"mp4"));
    assert!(dir.join("screen").join("journal.jsonl").is_file());
    engine.shutdown();
    fake.stop();
}

/// Speaker ids and labels come back with a restore: data folder A's `transcript.db` is seeded with
/// three call speakers, `speakers.mode = nemotron` and passages that name them, so no diarizer is
/// needed; a fresh data folder restores the meeting and sends the same speakers and passages
/// (contract 2.5).
fn a_restored_meeting_keeps_its_speakers() {
    let fake = fake_s3();
    let a = harness("speakers-a", json!({"meetings_retention": "keep"}));
    let engine_a = a.start();
    connect_bucket(&engine_a, &fake.endpoint());
    let code = recovery_code(&engine_a);
    let id = record(&engine_a, &a.data(), 3000);
    wait_uploaded(&engine_a);
    // The transcript snapshots in the bucket, by object name: a changed one gets a new name.
    let transcripts = |fake: &FakeS3| -> Vec<String> {
        decrypt_all(fake, &code)
            .into_iter()
            .filter(|(_, plain)| support::kind_of(plain) == "transcript")
            .map(|(name, _)| name)
            .collect()
    };
    let before = transcripts(&fake);
    engine_a.shutdown();

    // Labels as a Nemotron meeting has them: call-1 to call-3, each call passage naming one.
    let dir_a = meeting_dir(&a.data(), &id);
    let seeded = {
        let t = Transcript::open(&dir_a).unwrap();
        for n in 1..=3 {
            t.save_speaker(&Speaker {
                id: format!("call-{n}"),
                track: Track::Call,
                label: format!("Speaker {n}"),
            })
            .unwrap();
        }
        t.meta_set(voice_meetings::transcript::MODE_KEY, "nemotron")
            .unwrap();
        let mut n = 0;
        for stored in t.passages().unwrap() {
            let mut p = stored.passage;
            if p.track == Track::Call {
                p.speaker = Some(format!("call-{}", n % 3 + 1));
                p.revision += 1;
                n += 1;
                t.update_passage(&p).unwrap();
            }
        }
        assert!(n >= 1, "the meeting has call passages");
        t.passages()
            .unwrap()
            .into_iter()
            .map(|s| (s.passage.id, s.passage.speaker))
            .collect::<Vec<_>>()
    };
    // A starts again, sees the changed transcript and uploads its new snapshot.
    let engine_a = a.start();
    wait_long(
        "the new transcript snapshot",
        Duration::from_secs(60),
        || transcripts(&fake).iter().any(|name| !before.contains(name)),
    );
    wait_uploaded(&engine_a);
    engine_a.shutdown();

    let b = harness("speakers-b", json!({"meetings_retention": "keep"}));
    let engine_b = b.start();
    engine_b
        .settings_sync_key("import", Some(code.clone()))
        .unwrap();
    connect_bucket(&engine_b, &fake.endpoint());
    engine_b.settings_sync_restore("start").unwrap();
    wait_done(&b.data(), &id);
    let snapshot = engine_b.meeting_control().unwrap().get(&id).unwrap();
    let mut speakers: Vec<(String, String)> = snapshot["speakers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            (
                s["id"].as_str().unwrap().to_string(),
                s["label"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    speakers.sort();
    assert_eq!(
        speakers
            .iter()
            .filter(|(id, _)| id.starts_with("call-"))
            .cloned()
            .collect::<Vec<_>>(),
        (1..=3)
            .map(|n| (format!("call-{n}"), format!("Speaker {n}")))
            .collect::<Vec<_>>(),
        "{snapshot}"
    );
    assert!(speakers.iter().any(|(id, _)| id == "mic"));
    let mut restored: Vec<(String, Option<String>)> = snapshot["passages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| {
            (
                p["id"].as_str().unwrap().to_string(),
                p["speaker"].as_str().map(str::to_string),
            )
        })
        .collect();
    restored.sort();
    let mut seeded = seeded;
    seeded.sort();
    assert_eq!(restored, seeded, "every passage keeps its speaker");
    engine_b.shutdown();
    fake.stop();
}

/// Voice refuses to show or import the recovery code while a meeting records the screen, and Settings
/// says so in `sync.screenRecording` (spec RUK-110 D18, contract 2.7): by the screen supervisor's
/// mode for the meeting that records, not by Voice's default.
fn the_key_dialogs_wait_while_the_screen_records() {
    if !cfg!(any(windows, target_os = "macos")) {
        println!("skipped: the screen process records on Windows only");
        return;
    }
    let h = screen_harness("key-screen", "keep");
    let fake = fake_s3();
    let engine = h.start();
    connect_bucket(&engine, &fake.endpoint());
    assert_eq!(sync_state(&engine)["screenRecording"], false);
    let code = recovery_code(&engine);

    let id = engine.start_meeting().unwrap();
    wait_recorded(&h.data(), &id, 1000);
    wait_for("Settings to say the screen records", || {
        sync_state(&engine)["screenRecording"] == true
    });
    for (action, code) in [("show", None), ("import", Some(code.clone()))] {
        let refused = engine.settings_sync_key(action, code).unwrap_err();
        assert_eq!(
            refused.code, "recording_screen",
            "{action}: {}",
            refused.message
        );
    }
    engine.stop_meeting(StopReason::User).unwrap();
    wait_done(&h.data(), &id);
    wait_for("Settings to say the screen stopped", || {
        sync_state(&engine)["screenRecording"] == false
    });
    assert_eq!(
        recovery_code(&engine),
        code,
        "the code shows once the meeting stopped"
    );

    // A meeting that records no screen leaves the dialogs alone, whatever Voice's default.
    let control = engine.meeting_control().unwrap();
    let audio_only = control
        .start(voice_protocol::StartArgs {
            screen: Some(voice_protocol::ScreenMode::Off),
            ..Default::default()
        })
        .unwrap();
    wait_recorded(&h.data(), &audio_only, 1000);
    assert_eq!(sync_state(&engine)["screenRecording"], false);
    assert_eq!(recovery_code(&engine), code);
    engine.stop_meeting(StopReason::User).unwrap();
    wait_done(&h.data(), &audio_only);
    engine.shutdown();
    fake.stop();
}

// The macOS keychain --------------------------------------------------------------------------

/// The login keychain in memory for the engine's Keychain protector: Deny as macOS answers it,
/// and a dialog left open, as a read that waits until the test lets it go. Never the real
/// keychain.
#[cfg(target_os = "macos")]
mod keychain {
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::mpsc::{channel, Receiver, Sender};
    use std::sync::{Arc, Mutex};

    use voice_sync::protect::keychain::{ItemStore, StoreError};

    #[derive(Clone, Default)]
    pub struct GateStore {
        items: Arc<Mutex<BTreeMap<String, Vec<u8>>>>,
        denied: Arc<Mutex<Option<StoreError>>>,
        /// The next read waits for this, as for an answer to the keychain dialog.
        gate: Arc<Mutex<Option<Receiver<()>>>>,
        waiting: Arc<AtomicBool>,
        reads: Arc<AtomicUsize>,
    }

    impl GateStore {
        pub fn deny(&self, error: StoreError) {
            *self.denied.lock().unwrap() = Some(error);
        }

        pub fn allow(&self) {
            *self.denied.lock().unwrap() = None;
        }

        /// The next read waits until the sender is used or dropped.
        pub fn hold(&self) -> Sender<()> {
            let (tx, rx) = channel();
            *self.gate.lock().unwrap() = Some(rx);
            tx
        }

        /// A read waits for the gate now.
        pub fn waiting(&self) -> bool {
            self.waiting.load(Ordering::SeqCst)
        }

        /// Reads so far: each is a keychain dialog after a new signature.
        pub fn reads(&self) -> usize {
            self.reads.load(Ordering::SeqCst)
        }
    }

    impl ItemStore for GateStore {
        fn get(&self, account: &str) -> Result<Vec<u8>, StoreError> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            let gate = self.gate.lock().unwrap().take();
            if let Some(gate) = gate {
                self.waiting.store(true, Ordering::SeqCst);
                let _ = gate.recv();
                self.waiting.store(false, Ordering::SeqCst);
            }
            if let Some(error) = *self.denied.lock().unwrap() {
                return Err(error);
            }
            let items = self.items.lock().unwrap();
            items.get(account).cloned().ok_or(StoreError::Missing)
        }

        fn set(&self, account: &str, secret: &[u8]) -> Result<(), StoreError> {
            if let Some(error) = *self.denied.lock().unwrap() {
                return Err(error);
            }
            self.items
                .lock()
                .unwrap()
                .insert(account.to_owned(), secret.to_vec());
            Ok(())
        }

        fn delete(&self, account: &str) -> Result<(), StoreError> {
            let mut items = self.items.lock().unwrap();
            items.remove(account).map(drop).ok_or(StoreError::Missing)
        }
    }
}

/// An engine whose sync keys live in `store`, connected to `fake` and up to date, then shut down:
/// the next start reads the key and the secret from the keychain again.
#[cfg(target_os = "macos")]
fn keychain_harness(name: &str, store: &keychain::GateStore, fake: &FakeS3) -> Harness {
    let mut h = harness(name, json!({"meetings_retention": "keep"}));
    h.protector = Arc::new(voice_sync::protect::keychain::Keychain::with_store(
        &h.data(),
        store.clone(),
    ));
    let engine = h.start();
    connect_bucket(&engine, &fake.endpoint());
    wait_uploaded(&engine);
    engine.shutdown();
    h
}

/// Deny in macOS's keychain dialog (errSecUserCanceled) after a new signature: Voice runs on,
/// Settings show the refusal with Try again instead of "everything is in the bucket", and
/// once the user allows Voice, Try again clears it and sync goes on.
#[cfg(target_os = "macos")]
fn a_refused_keychain_shows_in_settings_until_allowed() {
    use voice_sync::protect::keychain::StoreError;

    let fake = fake_s3();
    let store = keychain::GateStore::default();
    let h = keychain_harness("sync-keychain-refused", &store, &fake);

    store.deny(StoreError::Denied(-128));
    let before = store.reads();
    let engine = h.start();
    wait_for("the refusal in Settings", || {
        sync_state(&engine)["state"] == "key"
    });
    let sync = sync_state(&engine);
    assert_eq!(sync["lastError"]["code"], "key_denied", "{sync}");
    let message = sync["lastError"]["message"].as_str().unwrap();
    assert!(message.contains("-128"), "{message}");
    assert_eq!(sync["key"]["exists"], false, "{sync}");
    // One dialog: after the key was refused, Voice doesn't ask for the bucket secret.
    assert_eq!(store.reads() - before, 1);
    // Show key says the same and doesn't offer to replace a key that is fine.
    assert_eq!(
        engine.settings_sync_key("show", None).unwrap_err().code,
        "key_denied"
    );
    let asked = store.reads();
    // Voice doesn't ask again by itself: the refusal stays until the user acts.
    std::thread::sleep(Duration::from_millis(1500));
    assert_eq!(store.reads(), asked);
    assert_eq!(sync_state(&engine)["state"], "key");

    // Try again, and Always Allow this time.
    store.allow();
    engine.settings_sync_key("retry", None).unwrap();
    wait_for("sync to go on after Always Allow", || {
        let sync = sync_state(&engine);
        sync["state"] == "idle" && sync["lastError"].is_null()
    });
    assert_eq!(sync_state(&engine)["key"]["exists"], true);
    engine.shutdown();
    fake.stop();
}

/// A keychain dialog nobody answers: the engine starts at once, Settings say sync waits for the
/// keychain, and a meeting starts and records. Once the dialog is answered, sync goes on and
/// the meeting reaches the bucket.
#[cfg(target_os = "macos")]
fn the_keychain_dialog_holds_up_neither_the_start_nor_a_meeting() {
    let fake = fake_s3();
    let store = keychain::GateStore::default();
    let h = keychain_harness("sync-keychain-open", &store, &fake);

    let answer = store.hold();
    let started = Instant::now();
    let engine = h.start();
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "the start took {:?}",
        started.elapsed()
    );
    wait_for("Settings to say sync waits for the keychain", || {
        sync_state(&engine)["state"] == "unlocking"
    });
    assert!(store.waiting());

    let id = engine.start_meeting().unwrap();
    wait_recorded(&h.data(), &id, 3000);
    engine.stop_meeting(StopReason::User).unwrap();
    wait_done(&h.data(), &id);
    assert!(store.waiting(), "the dialog is still open");
    assert_eq!(sync_state(&engine)["state"], "unlocking");

    answer.send(()).unwrap();
    wait_uploaded(&engine);
    let code = recovery_code(&engine);
    assert!(bucket_kinds(&fake, &code).contains(&"audio"));
    assert!(sync_state(&engine)["lastError"].is_null());
    engine.shutdown();
    fake.stop();
}
