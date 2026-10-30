//! The meeting controller against the real recorder, with synthetic sources.
//!
//! This test binary has its own main (`harness = false`) so it can also be the recorder: run
//! with `VOICE_ENGINE_TEST_ROLE=recorder` it calls `voice_recorder::run`, the same function the
//! `rukoo-voice-recorder` binary's main calls. Set `VOICE_ENGINE_TEST_RECORDER` to the path of a
//! built `rukoo-voice-recorder` to run the tests against that binary instead.

mod support;

use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use support::{lock, wait_for, Harness, TempDir};
use voice_bridge::{EventLog, MeetingControl};
use voice_engine::meetings::bridge::{Control, Presence};
use voice_engine::meetings::controller::{Change, Controller, ControllerOptions, ControllerTiming};
use voice_engine::{PillPhase, StopReason};
use voice_input::Key;
use voice_protocol::{ErrorCode, StartArgs, StartedBy, Track};
use voice_recorder::meeting::read_recorder_file;
use voice_recorder::timeline::{self, Line};

const ROLE: &str = "VOICE_ENGINE_TEST_ROLE";
const REAL_RECORDER: &str = "VOICE_ENGINE_TEST_RECORDER";

fn main() {
    if std::env::var(ROLE).as_deref() == Ok("recorder") {
        let args: Vec<String> = std::env::args().skip(1).collect();
        if let Err(e) = voice_recorder::run(&args) {
            eprintln!("rukoo-voice-recorder: {e}");
            std::process::exit(e.code);
        }
        return;
    }
    // Single-threaded here, so setting the variable is safe; every recorder the controller
    // starts from now on inherits it.
    std::env::set_var(ROLE, "recorder");
    let tests: Vec<(&str, fn())> = vec![
        ("commands_reach_the_recorder", commands_reach_the_recorder),
        (
            "the_watchdog_resumes_a_killed_recorder",
            the_watchdog_resumes_a_killed_recorder,
        ),
        (
            "the_watchdog_gives_up_after_its_restarts",
            the_watchdog_gives_up_after_its_restarts,
        ),
        (
            "a_new_controller_reattaches_to_a_live_recorder",
            a_new_controller_reattaches_to_a_live_recorder,
        ),
        (
            "a_cut_off_meeting_is_finished_at_start",
            a_cut_off_meeting_is_finished_at_start,
        ),
        (
            "rukoo_commands_go_through_meeting_control",
            rukoo_commands_go_through_meeting_control,
        ),
        ("a_meeting_through_the_engine", a_meeting_through_the_engine),
        (
            "a_restarted_engine_reattaches_and_stops_the_meeting",
            a_restarted_engine_reattaches_and_stops_the_meeting,
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

fn recorder_exe() -> PathBuf {
    std::env::var_os(REAL_RECORDER)
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_exe().unwrap())
}

fn timing() -> ControllerTiming {
    ControllerTiming {
        poll: Duration::from_millis(100),
        start_timeout: Duration::from_secs(20),
        backoff: vec![
            Duration::from_millis(100),
            Duration::from_millis(200),
            Duration::from_millis(300),
        ],
        stable_after: Duration::from_secs(60),
        ping_failures: 3,
        recorder_args: vec!["--segment-ms".into(), "1000".into()],
    }
}

fn sources() -> Vec<(String, String)> {
    vec![
        ("mic".into(), "synthetic:tone:440".into()),
        ("call".into(), "synthetic:idle".into()),
    ]
}

type Changes = Arc<Mutex<Vec<Change>>>;

fn controller(data: &Path, timing: ControllerTiming) -> (Arc<Controller>, Changes) {
    let changes: Changes = Arc::default();
    let controller = Controller::new(
        ControllerOptions {
            data_dir: data.to_path_buf(),
            recorder_exe: recorder_exe(),
            sources: sources(),
            timing,
        },
        {
            let changes = Arc::clone(&changes);
            move |change| lock(&changes).push(change)
        },
    )
    .unwrap();
    (controller, changes)
}

fn wait_change(changes: &Changes, what: &str, mut matches: impl FnMut(&Change) -> bool) -> Change {
    let mut found = None;
    wait_for(what, || {
        found = lock(changes).iter().find(|c| matches(c)).cloned();
        found.is_some()
    });
    found.unwrap()
}

fn count(changes: &Changes, matches: impl Fn(&Change) -> bool) -> usize {
    lock(changes).iter().filter(|c| matches(c)).count()
}

fn meeting_dir(data: &Path, id: &str) -> PathBuf {
    data.join("meetings").join(id)
}

fn lines(data: &Path, id: &str) -> Vec<Line> {
    timeline::read(&meeting_dir(data, id).join("timeline.jsonl")).unwrap()
}

fn wait_clock(controller: &Controller, at_least: u64) {
    wait_for(&format!("meeting time {at_least} ms"), || {
        controller.current().is_some_and(|r| r.at_ms >= at_least)
    });
}

/// Ends a recorder this test started, by its process id.
fn kill(pid: u32) {
    #[cfg(windows)]
    let status = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/F"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap();
    #[cfg(not(windows))]
    let status = std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .status()
        .unwrap();
    assert!(status.success(), "kill {pid}");
}

fn alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        let out = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
    }
    #[cfg(not(windows))]
    {
        Path::new(&format!("/proc/{pid}")).exists()
    }
}

fn recorder_pid(data: &Path, id: &str) -> u32 {
    read_recorder_file(&meeting_dir(data, id))
        .expect("recorder.json")
        .pid
}

// The tests ----------------------------------------------------------------------------------

fn commands_reach_the_recorder() {
    let dir = TempDir::new("commands");
    let data = dir.join("data");
    let (c, changes) = controller(&data, timing());
    let id = c
        .start(
            StartArgs {
                title: Some("Weekly with Anna".into()),
                ..StartArgs::default()
            },
            StartedBy::Voice,
        )
        .unwrap();
    assert!(
        matches!(&lock(&changes)[0], Change::Started { id: started, at_ms: 0 } if *started == id)
    );
    let meeting: Value = serde_json::from_slice(
        &std::fs::read(meeting_dir(&data, &id).join("meeting.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(meeting["title"], "Weekly with Anna");
    assert_eq!(meeting["startedBy"], "voice");
    assert_eq!(meeting["tracks"], json!(["mic", "call"]));
    assert_eq!(meeting["sources"]["mic"], "synthetic:tone:440");
    assert_eq!(meeting["screen"], "off");
    let busy = c.start(StartArgs::default(), StartedBy::Rukoo).unwrap_err();
    assert_eq!(
        (busy.code, busy.meeting.as_deref()),
        (ErrorCode::Busy, Some(id.as_str()))
    );

    wait_clock(&c, 1000);
    wait_change(&changes, "a clock tick", |c| {
        matches!(c, Change::Clock { mic_ok: true, .. })
    });
    c.pause(None).unwrap();
    assert_eq!(c.pause(None).unwrap_err().code, ErrorCode::NotRecording);
    assert!(c.current().unwrap().paused);
    c.resume(Some(&id)).unwrap();
    let (mark, at) = c.mark(Some(&id), Some("Decision")).unwrap();
    assert_eq!(mark, "k-1");
    assert!(at >= 1000);
    assert_eq!(c.dictation("start"), Some(id.clone()));

    // The tap carries the microphone while the meeting records.
    let file = c.tap().unwrap();
    let heard = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let tap = voice_engine::meetings::tap::open(&file, {
        let heard = Arc::clone(&heard);
        Box::new(move |pcm: &[i16]| {
            heard.fetch_add(pcm.len(), Ordering::SeqCst);
        })
    })
    .unwrap();
    wait_for("tapped audio", || heard.load(Ordering::SeqCst) >= 8000);
    drop(tap);
    c.dictation("end");

    c.stop(Some(&id), "user").unwrap();
    let ended = wait_change(&changes, "the end", |c| matches!(c, Change::Ended { .. }));
    assert!(matches!(ended, Change::Ended { reason, .. } if reason == "user"));
    assert!(c.current().is_none());
    assert!(!meeting_dir(&data, &id).join("recorder.json").exists());
    assert_eq!(
        c.stop(Some(&id), "user").unwrap_err().code,
        ErrorCode::NotRecording
    );
    assert_eq!(
        c.stop(Some("m-20000101-000000-0000"), "user")
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );

    let lines = lines(&data, &id);
    let kinds: Vec<String> = lines
        .iter()
        .map(|l| {
            serde_json::to_value(l).unwrap()["kind"]
                .as_str()
                .unwrap_or("")
                .to_string()
        })
        .collect();
    for kind in ["session", "pause", "resume", "mark", "dictation", "stop"] {
        assert!(kinds.contains(&kind.to_string()), "{kind} in {kinds:?}");
    }
    assert!(lines.iter().any(|l| matches!(l, Line::Mark { id, label: Some(label), .. } if id == "k-1" && label == "Decision")));
    assert!(lines
        .iter()
        .any(|l| matches!(l, Line::Dictation { state, .. } if state == "end")));
    assert!(matches!(lines.last(), Some(Line::Stop { reason, .. }) if reason == "user"));
    c.shutdown();
}

fn the_watchdog_resumes_a_killed_recorder() {
    let dir = TempDir::new("watchdog");
    let data = dir.join("data");
    let (c, changes) = controller(&data, timing());
    let id = c.start(StartArgs::default(), StartedBy::Voice).unwrap();
    wait_clock(&c, 1500);
    let first = recorder_pid(&data, &id);
    kill(first);
    wait_change(&changes, "the restart", |c| {
        matches!(c, Change::Restarted { attempt: 1, .. })
    });
    let second = recorder_pid(&data, &id);
    assert_ne!(first, second);
    let restarted_at = c.current().unwrap().at_ms;
    wait_clock(&c, restarted_at + 1000);
    c.stop(None, "user").unwrap();
    let lines = lines(&data, &id);
    let sessions: Vec<bool> = lines
        .iter()
        .filter_map(|l| match l {
            Line::Session { resumed, .. } => Some(*resumed),
            _ => None,
        })
        .collect();
    assert_eq!(sessions, [false, true]);
    assert!(
        lines.iter().any(|l| matches!(l, Line::Crash { .. })),
        "the gap is marked"
    );
    assert!(matches!(lines.last(), Some(Line::Stop { reason, .. }) if reason == "user"));
    assert!(
        !alive(second) || {
            std::thread::sleep(Duration::from_secs(2));
            !alive(second)
        }
    );
    c.shutdown();
}

fn the_watchdog_gives_up_after_its_restarts() {
    let dir = TempDir::new("give-up");
    let data = dir.join("data");
    let mut timing = timing();
    timing.backoff.truncate(2);
    let (c, changes) = controller(&data, timing);
    let id = c.start(StartArgs::default(), StartedBy::Voice).unwrap();
    for attempt in 1..=2 {
        wait_for("a recorder", || {
            read_recorder_file(&meeting_dir(&data, &id)).is_some()
        });
        wait_clock(&c, 500);
        kill(recorder_pid(&data, &id));
        wait_change(
            &changes,
            "a restart",
            |c| matches!(c, Change::Restarted { attempt: a, .. } if *a == attempt),
        );
    }
    wait_for("a recorder", || {
        read_recorder_file(&meeting_dir(&data, &id)).is_some()
    });
    kill(recorder_pid(&data, &id));
    let ended = wait_change(&changes, "the end", |c| matches!(c, Change::Ended { .. }));
    assert!(matches!(ended, Change::Ended { reason, .. } if reason == "interrupted"));
    assert_eq!(count(&changes, |c| matches!(c, Change::Notify { .. })), 1);
    assert!(
        matches!(lines(&data, &id).last(), Some(Line::Stop { reason, .. }) if reason == "interrupted")
    );
    assert!(c.current().is_none());
    c.shutdown();
}

fn a_new_controller_reattaches_to_a_live_recorder() {
    let dir = TempDir::new("reattach");
    let data = dir.join("data");
    let (a, _) = controller(&data, timing());
    let id = a.start(StartArgs::default(), StartedBy::Voice).unwrap();
    wait_clock(&a, 500);
    let pid = recorder_pid(&data, &id);
    // The app quits: the recorder goes on.
    a.shutdown();
    drop(a);
    std::thread::sleep(Duration::from_millis(500));
    assert!(alive(pid), "the recorder outlives its controller");

    let (b, changes) = controller(&data, timing());
    b.recover();
    let reattached = wait_change(&changes, "the reattach", |c| {
        matches!(c, Change::Reattached { .. })
    });
    assert!(
        matches!(&reattached, Change::Reattached { id: found, paused: false, at_ms } if *found == id && *at_ms >= 500)
    );
    assert_eq!(b.current().unwrap().id, id);
    assert_eq!(b.mark(None, None).unwrap().0, "k-1");
    b.stop(None, "rukoo").unwrap();
    assert!(
        matches!(lines(&data, &id).last(), Some(Line::Stop { reason, .. }) if reason == "rukoo")
    );
    wait_for("the recorder to exit", || !alive(pid));
    b.shutdown();
}

fn a_cut_off_meeting_is_finished_at_start() {
    let dir = TempDir::new("finalize");
    let data = dir.join("data");
    let (a, _) = controller(&data, timing());
    let id = a.start(StartArgs::default(), StartedBy::Voice).unwrap();
    wait_clock(&a, 1500);
    a.shutdown();
    drop(a);
    kill(recorder_pid(&data, &id));
    assert_eq!(
        voice_engine::meetings::pipeline::Library::open(&data)
            .unwrap()
            .interrupted(),
        std::slice::from_ref(&id)
    );

    let (b, changes) = controller(&data, timing());
    b.recover();
    wait_change(
        &changes,
        "the finalize",
        |c| matches!(c, Change::Finalized { id: f } if *f == id),
    );
    assert!(b.current().is_none());
    let lines = lines(&data, &id);
    assert!(
        matches!(lines.last(), Some(Line::Stop { reason, t, .. }) if reason == "interrupted" && *t >= 1000)
    );
    assert!(b.library().interrupted().is_empty());
    // A second start finds nothing left to do.
    let (c, again) = controller(&data, timing());
    c.recover();
    std::thread::sleep(Duration::from_millis(200));
    assert!(lock(&again).is_empty());
    b.shutdown();
    c.shutdown();
}

fn rukoo_commands_go_through_meeting_control() {
    let dir = TempDir::new("control");
    let data = dir.join("data");
    let (c, changes) = controller(&data, timing());
    let control = Control {
        controller: Arc::clone(&c),
        dictating: Arc::default(),
        presence: Arc::new(Presence::default()),
    };
    assert_eq!(MeetingControl::status(&control).recording, None);
    assert!(control.presence.connected(), "Rukoo asked for the status");
    let id = MeetingControl::start(
        &control,
        StartArgs {
            title: Some("From Rukoo".into()),
            tracks: Some(vec![Track::Mic]),
            screen: None,
            context: Some(json!({"calendarEvent": "abc"}).as_object().unwrap().clone()),
        },
    )
    .unwrap();
    let status = MeetingControl::status(&control);
    assert_eq!(status.recording.map(|m| m.into_string()), Some(id.clone()));
    let meeting: Value = serde_json::from_slice(
        &std::fs::read(meeting_dir(&data, &id).join("meeting.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        (meeting["startedBy"].as_str(), meeting["tracks"].clone()),
        (Some("rukoo"), json!(["mic"]))
    );
    assert_eq!(meeting["context"]["calendarEvent"], "abc");
    wait_clock(&c, 300);
    control.pause(&id).unwrap();
    control.resume(&id).unwrap();
    assert_eq!(control.mark(&id, Some("x")).unwrap().0, "k-1");
    assert_eq!(control.get(&id).unwrap_err().code, ErrorCode::NotAvailable);
    assert_eq!(
        control.frame(&id, 0).unwrap_err().code,
        ErrorCode::NotAvailable
    );
    assert_eq!(
        control.get("m-20000101-000000-0000").unwrap_err().code,
        ErrorCode::NotFound
    );
    let list = control.list(10);
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].title, "From Rukoo");
    control.stop(&id).unwrap();
    assert!(
        matches!(wait_change(&changes, "the end", |c| matches!(c, Change::Ended { .. })), Change::Ended { reason, .. } if reason == "rukoo")
    );
    assert_eq!(control.stop(&id).unwrap_err().code, ErrorCode::NotRecording);
    c.shutdown();
}

fn engine_harness(name: &str) -> Harness {
    let mut h = Harness::new(name);
    h.recorder_exe = recorder_exe();
    h.timing = timing();
    h.test_sources = Some("mic=synthetic:tone:440,call=synthetic:idle".into());
    h.config(json!({}));
    h
}

fn stored(data: &Path) -> Vec<voice_bridge::Stored> {
    EventLog::open(data).unwrap().after(0).unwrap()
}

fn a_meeting_through_the_engine() {
    let h = engine_harness("engine-meeting");
    let engine = h.start();
    let id = engine.start_meeting().unwrap();
    let pill = h.sink.wait_phase(PillPhase::Meeting);
    let meeting = pill.meeting.unwrap();
    assert_eq!(
        (meeting.state.as_str(), meeting.stop_enabled),
        ("recording", true)
    );
    assert_eq!(engine.tray_state().meeting.as_deref(), Some("recording"));
    wait_for("meeting.started for Rukoo", || {
        stored(&h.data())
            .iter()
            .any(|s| s.event == "meeting.started" && s.meeting.as_deref() == Some(id.as_str()))
    });
    assert!(stored(&h.data())
        .iter()
        .any(|s| s.event == "status" && s.data["recording"] == id.as_str()));

    // Dictation during the meeting reads the recorder's tap, not a second capture.
    h.speech.say("noted");
    h.keys.down(Key::F13);
    wait_for("dictation to listen", || {
        h.sink
            .last_pill()
            .is_some_and(|p| p.phase == PillPhase::Listening)
    });
    assert!(
        !h.sink.last_pill().unwrap().meeting.unwrap().stop_enabled,
        "no stop button while dictating"
    );
    std::thread::sleep(Duration::from_millis(700));
    h.keys.up(Key::F13);
    wait_for("the insertion", || h.input.texts() == ["noted"]);
    assert_eq!(
        h.mic.opens.load(Ordering::SeqCst),
        0,
        "the microphone was captured once"
    );
    assert!(
        h.speech.heard()[0] >= 8000,
        "the tap delivered the tone: {:?}",
        h.speech.heard()
    );

    engine.pause_meeting().unwrap();
    wait_for("a paused pill", || {
        h.sink
            .last_pill()
            .and_then(|p| p.meeting)
            .is_some_and(|m| m.state == "paused")
    });
    engine.resume_meeting().unwrap();
    // Two clicks stop it; one only asks.
    engine.pill_stop_clicked();
    wait_for("Stop?", || {
        h.sink
            .last_pill()
            .and_then(|p| p.meeting)
            .is_some_and(|m| m.confirm_stop)
    });
    assert!(engine.tray_state().meeting.is_some());
    engine.pill_stop_clicked();
    wait_for("saving", || {
        h.sink
            .last_pill()
            .and_then(|p| p.meeting)
            .is_some_and(|m| m.state == "processing")
    });
    h.sink.wait_hidden_after(PillPhase::Meeting);
    assert_eq!(engine.tray_state().meeting, None);
    wait_for("meeting.state processing for Rukoo", || {
        stored(&h.data())
            .iter()
            .any(|s| s.event == "meeting.state" && s.data["state"] == "processing")
    });
    let events = stored(&h.data());
    assert!(
        events
            .iter()
            .any(|s| s.event == "mark" && s.data["kind"] == "dictation"),
        "the dictation stretch is marked"
    );
    assert!(events
        .iter()
        .any(|s| s.event == "meeting.state" && s.data["state"] == "paused"));
    let lines = lines(&h.data(), &id);
    assert!(lines
        .iter()
        .any(|l| matches!(l, Line::Dictation { state, .. } if state == "start")));
    assert!(matches!(lines.last(), Some(Line::Stop { reason, .. }) if reason == "user"));
    engine.shutdown();
}

fn a_restarted_engine_reattaches_and_stops_the_meeting() {
    let h = engine_harness("engine-reattach");
    let engine = h.start();
    let id = engine.start_meeting().unwrap();
    wait_for("a recording", || {
        h.sink
            .last_pill()
            .is_some_and(|p| p.phase == PillPhase::Meeting)
    });
    let pid = recorder_pid(&h.data(), &id);
    // Quitting Voice never stops a recorder that records.
    engine.shutdown();
    drop(engine);
    std::thread::sleep(Duration::from_millis(500));
    assert!(alive(pid));
    assert!(read_recorder_file(&meeting_dir(&h.data(), &id)).is_some());

    let again = h.start();
    wait_for("the reattached meeting", || {
        again.tray_state().meeting.as_deref() == Some("recording")
    });
    again.stop_meeting(StopReason::User).unwrap();
    assert_eq!(again.tray_state().meeting, None);
    assert!(
        matches!(lines(&h.data(), &id).last(), Some(Line::Stop { reason, .. }) if reason == "user")
    );
    wait_for("the recorder to exit", || !alive(pid));
    again.shutdown();
}
