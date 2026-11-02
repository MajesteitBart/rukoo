//! Bucket sync through the whole engine against the real recorder and the fake bucket (spec
//! RUK-110 4.5), and media links through `media.open` and `media.read`.
//!
//! Like tests/meetings.rs, this binary has its own main (`harness = false`) so it can also be the
//! recorder: run with `VOICE_ENGINE_TEST_ROLE=recorder` it calls `voice_recorder::run`. Sources
//! are synthetic tones; no real audio is recorded.

mod support;

use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde_json::{json, Value};
use support::{
    bucket_kinds, connect_bucket, decrypt_all, fake_s3, fast_sync, sync_state, wait_for, Harness,
};
use voice_bridge::{ControlError, EventLog, MediaKind, MediaOpenArgs, MeetingControl};
use voice_engine::media::ScreenMedia;
use voice_engine::meetings::controller::ControllerTiming;
use voice_engine::{Engine, StopReason};
use voice_meetings::TrackReader;
use voice_protocol::{ErrorCode, MeetingId};
use voice_recorder::timeline::{self, History, Line};
use voice_s3_fake::{FakeS3, Op};
use voice_sync::{ScreenFile, ScreenFileKind, ScreenFiles};

const ROLE: &str = "VOICE_ENGINE_TEST_ROLE";

fn main() {
    if std::env::var(ROLE).as_deref() == Ok("recorder") {
        let args: Vec<String> = std::env::args().skip(1).collect();
        if let Err(e) = voice_recorder::run(&args) {
            eprintln!("rukoo-voice-recorder: {e}");
            std::process::exit(e.code);
        }
        return;
    }
    // Single-threaded here, so setting the variable is safe; every recorder started from now on
    // inherits it.
    std::env::set_var(ROLE, "recorder");
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
            "media_comes_back_from_the_bucket",
            media_comes_back_from_the_bucket,
        ),
        (
            "a_restored_meeting_reaches_the_bridge",
            a_restored_meeting_reaches_the_bridge,
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
/// closed and following the one before, and a stop.
fn assert_steady(data: &Path, id: &str) {
    let lines = lines(data, id);
    let mut last: Option<u64> = None;
    for line in &lines {
        match line {
            Line::Heartbeat { t, .. } => {
                if let Some(before) = last {
                    assert!(t - before <= 1300, "{id}: heartbeats {before} and {t}");
                }
                last = Some(*t);
            }
            Line::DeviceLost { .. } | Line::Crash { .. } => panic!("{id}: {line:?}"),
            _ => {}
        }
    }
    assert!(
        matches!(lines.last(), Some(Line::Stop { .. })),
        "{id} has no stop"
    );
    let history = History::from_lines(&lines);
    for track in ["mic", "call"] {
        let mut segments: Vec<_> = history
            .segments
            .iter()
            .filter(|s| s.track == track)
            .collect();
        segments.sort_by_key(|s| s.seq);
        assert!(segments.len() >= 20, "{id}/{track}: {}", segments.len());
        for pair in segments.windows(2) {
            assert_eq!(pair[1].seq, pair[0].seq + 1, "{id}/{track}");
            let end = pair[0].t + pair[0].ended.expect("a closed segment") / 16;
            assert!(
                pair[1].t.abs_diff(end) <= 200,
                "{id}/{track}: a gap between {} and {}",
                pair[0].seq,
                pair[1].seq
            );
        }
        assert!(segments.iter().all(|s| s.ended.is_some()), "{id}/{track}");
    }
}

fn a_failing_bucket_never_slows_the_recorder() {
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
        assert_steady(&h.data(), &id);
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
    assert_eq!(sync_state(&engine)["available"], false);
    assert_eq!(engine.settings_state()["features"]["sync"], false);
    let id = record(&engine, &h.data(), 2000);
    std::thread::sleep(Duration::from_millis(3000));
    let audio = meeting_dir(&h.data(), &id).join("audio");
    assert!(audio.is_dir(), "a broken queue never lets audio go");

    // Turning the switch off is the way out.
    engine
        .settings_set("storage.sync.enabled", json!(false))
        .unwrap();
    wait_for("the audio to go with the switch off", || !audio.exists());
    engine.shutdown();
}

// Media links --------------------------------------------------------------------------------

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
    fn list(&self, meeting_dir: &Path, stopped: bool) -> Vec<ScreenFile> {
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
        files
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

/// The parts of `media_open_serves_a_frame_and_a_clip` that need no real screen recording: a
/// frame on disk, the same frame fetched back from the bucket, and a clip that went mid-read.
/// The real cutter's stretches come with RUK-108.
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

    // Another data folder with the saved key and the same bucket.
    let b = harness("restore-b", json!({"meetings_retention": "keep"}));
    let engine_b = b.start();
    engine_b
        .settings_sync_key("import", Some(code.clone()))
        .unwrap();
    connect_bucket(&engine_b, &fake.endpoint());
    let list = engine_b.settings_sync_restore("list").unwrap();
    let meetings = list["meetings"].as_array().unwrap();
    assert_eq!(meetings.len(), 1, "{list}");
    assert_eq!(meetings[0]["id"], id.as_str());
    assert_eq!(meetings[0]["startedAt"], snapshot_a["meeting"]["startedAt"]);
    engine_b.settings_sync_restore("start").unwrap();
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
    // The audio comes back when a link needs it.
    let control = engine_b.meeting_control().unwrap();
    let wav = read_all(
        &*control,
        &open_ready(&*control, &audio(&id, 0, Some(20_000))),
        1 << 20,
    );
    let dir_a = meeting_dir(&a.data(), &id);
    assert_eq!(wav, expected_mix(&dir_a, 0, recorded_end(&dir_a)));
    assert_eq!(
        engine_b.settings_state()["sync"]["restore"]["state"],
        "done"
    );
    engine_b.shutdown();
    fake.stop();
}
