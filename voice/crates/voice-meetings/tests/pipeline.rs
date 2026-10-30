//! The pipeline over meeting folders written the way the recorder writes them, with recognizers
//! that need no model: restarts, the consent gate, failures, word timings and dictation.

mod common;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use common::*;
use serde_json::{json, Value};
use voice_bridge::EventLog;
use voice_meetings::{Library, Pipeline, PipelineOptions, PipelineState, Timing, Transcript};
use voice_protocol::{MeetingState, Track};

/// A stopped two-track recording: the microphone speaks at 0-2 s and 3-5 s, the call is silent,
/// a user mark at 3 s and dictation from 0.5 to 1.5 s.
fn finished_recording(lib: &Library) -> Recording {
    let rec = Recording::new(lib, &[Track::Mic, Track::Call]);
    rec.session(0, 1);
    rec.segment(
        "mic",
        1,
        0,
        &speech(&[(2.0, true), (1.0, false), (2.0, true), (1.5, false)]),
    );
    rec.segment("call", 1, 0, &speech(&[(6.5, false)]));
    rec.line(json!({"kind":"dictation","t":500,"state":"start"}));
    rec.line(json!({"kind":"dictation","t":1500,"state":"end"}));
    rec.line(json!({"kind":"mark","t":3000,"id":"k-1","label":"Decision"}));
    rec.stop(6500);
    rec
}

fn fast() -> Timing {
    Timing {
        poll: Duration::from_millis(10),
        busy_poll: Duration::from_millis(1),
        retry_first: Duration::from_millis(10),
        retry_max: Duration::from_millis(40),
        attempts_after_stop: 3,
    }
}

fn echo() -> PipelineOptions {
    PipelineOptions {
        timing: fast(),
        ..PipelineOptions::new(Arc::new(Echo::default()))
    }
}

fn passages(events: &[voice_bridge::Stored]) -> Vec<(String, u64, u64, String, bool, u64)> {
    of(events, "passage")
        .iter()
        .map(|p| {
            (
                p["id"].as_str().unwrap().to_owned(),
                p["start"].as_u64().unwrap(),
                p["end"].as_u64().unwrap(),
                p["text"].as_str().unwrap().to_owned(),
                p["dictation"].as_bool().unwrap(),
                p["revision"].as_u64().unwrap(),
            )
        })
        .collect()
}

fn states(events: &[voice_bridge::Stored]) -> Vec<String> {
    of(events, "meeting.state")
        .iter()
        .map(|s| s["state"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn a_recording_is_transcribed_once_and_restarts_send_nothing_twice() {
    let tmp = TempDir::new("pipeline-once");
    let lib = Library::open(tmp.path()).unwrap();
    let log = EventLog::open(tmp.path()).unwrap();
    let rec = finished_recording(&lib);
    let id = rec.id();

    let handle = Pipeline::start(rec.dir.clone(), log.clone(), echo());
    wait_for_state(&handle, |s| *s == PipelineState::Done);
    handle.shutdown();

    let first = events(&log, &id);
    assert_eq!(first[0].event, "meeting.started");
    assert_eq!(first[0].data["title"], "Planning");
    let speakers: Vec<&Value> = of(&first, "speaker");
    assert_eq!(
        speakers[0],
        &json!({"id":"mic","track":"mic","label":"You"})
    );
    assert_eq!(
        speakers[1],
        &json!({"id":"call-1","track":"call","label":"Speaker 1"})
    );
    assert_eq!(states(&first), ["recording", "processing", "done"]);
    let last = first.last().unwrap();
    assert_eq!(last.event, "meeting.state");
    assert_eq!(
        last.data,
        json!({"state":"done","at":6500,"endedAt":1_793_000_006_500u64})
    );
    let processing = of(&first, "meeting.state")[1];
    assert_eq!(processing["reason"], "user");
    assert_eq!(
        passages(&first),
        vec![
            (
                "mic-000000000".into(),
                0,
                2400,
                "heard 2400 ms".into(),
                true,
                1
            ),
            (
                "mic-000002400".into(),
                2400,
                5400,
                "heard 3000 ms".into(),
                false,
                1
            ),
        ]
    );
    let first_passage = of(&first, "passage")[0];
    assert_eq!(first_passage["speaker"], "mic");
    assert_eq!(first_passage["language"], "en");
    let marks: Vec<&str> = of(&first, "mark")
        .iter()
        .map(|m| m["id"].as_str().unwrap())
        .collect();
    assert_eq!(marks, ["dict-500", "k-1"]);
    assert_no_repeats(&first);

    // A second pipeline over the finished meeting sends nothing new.
    let handle = Pipeline::start(rec.dir.clone(), log.clone(), echo());
    wait_for_state(&handle, |s| *s == PipelineState::Done);
    handle.shutdown();
    assert_eq!(events(&log, &id), first);

    // Voice died after the log took the events and before transcript.db noted them: the log
    // still tells the next pipeline what Rukoo has.
    Transcript::open(rec.dir.path())
        .unwrap()
        .set_emitted(&HashMap::new())
        .unwrap();
    let handle = Pipeline::start(rec.dir.clone(), log.clone(), echo());
    wait_for_state(&handle, |s| *s == PipelineState::Done);
    handle.shutdown();
    assert_eq!(events(&log, &id), first);

    let summary = &lib.list(5)[0];
    assert_eq!(
        (summary.state, summary.duration),
        (MeetingState::Done, 6500)
    );
    let snapshot = lib.get(&id, &log).unwrap();
    assert_eq!(snapshot["meeting"]["state"], "done");
    assert_eq!(snapshot["passages"].as_array().unwrap().len(), 2);
    assert_eq!(snapshot["marks"].as_array().unwrap().len(), 2);
    assert_eq!(snapshot["head"], log.head());
}

#[test]
fn transcription_waits_for_consent_then_catches_up() {
    let tmp = TempDir::new("pipeline-consent");
    let lib = Library::open(tmp.path()).unwrap();
    let log = EventLog::open(tmp.path()).unwrap();
    let rec = finished_recording(&lib);
    let agreed = Arc::new(AtomicBool::new(false));
    let echo_stt = Arc::new(Echo::default());
    let options = PipelineOptions {
        transcription_allowed: {
            let agreed = agreed.clone();
            Arc::new(move || {
                if agreed.load(Ordering::SeqCst) {
                    Ok(())
                } else {
                    Err("Agree to send meeting audio to OpenAI in Settings.".into())
                }
            })
        },
        timing: fast(),
        ..PipelineOptions::new(echo_stt.clone())
    };
    let handle = Pipeline::start(rec.dir.clone(), log.clone(), options);
    let state = wait_for_state(&handle, |s| matches!(s, PipelineState::Waiting { .. }));
    assert_eq!(
        state,
        PipelineState::Waiting {
            reason: "Agree to send meeting audio to OpenAI in Settings.".into()
        }
    );
    // The recording's own events still reach Rukoo; nothing is transcribed.
    wait_until("the processing state", Duration::from_secs(10), || {
        states(&events(&log, &rec.id()))
            .contains(&"processing".to_owned())
            .then_some(())
    });
    std::thread::sleep(Duration::from_millis(200));
    assert!(passages(&events(&log, &rec.id())).is_empty());
    assert_eq!(echo_stt.calls.load(Ordering::SeqCst), 0);

    agreed.store(true, Ordering::SeqCst);
    handle.wake();
    wait_for_state(&handle, |s| *s == PipelineState::Done);
    let all = events(&log, &rec.id());
    assert_eq!(passages(&all).len(), 2);
    assert_eq!(states(&all), ["recording", "processing", "done"]);
}

#[test]
fn a_recognizer_that_keeps_failing_after_the_stop_fails_the_meeting() {
    let tmp = TempDir::new("pipeline-failed");
    let lib = Library::open(tmp.path()).unwrap();
    let log = EventLog::open(tmp.path()).unwrap();
    let rec = finished_recording(&lib);
    let options = PipelineOptions {
        timing: fast(),
        ..PipelineOptions::new(Arc::new(Offline))
    };
    let handle = Pipeline::start(rec.dir.clone(), log.clone(), options);
    let state = wait_for_state(&handle, |s| matches!(s, PipelineState::Failed { .. }));
    let reason = "Network error. Check your connection.";
    assert_eq!(
        state,
        PipelineState::Failed {
            reason: reason.into()
        }
    );
    let all = events(&log, &rec.id());
    assert_eq!(
        all.last().unwrap().data,
        json!({"state":"failed","at":6500,"endedAt":1_793_000_006_500u64,"reason":reason})
    );
    assert_eq!(lib.list(1)[0].state, MeetingState::Failed);

    // The audio stays; a later pipeline with a working recognizer finishes the meeting.
    let handle = Pipeline::start(rec.dir.clone(), log.clone(), echo());
    wait_for_state(&handle, |s| *s == PipelineState::Done);
    let all = events(&log, &rec.id());
    assert_eq!(states(&all), ["recording", "processing", "failed", "done"]);
    assert_eq!(passages(&all).len(), 2);
    assert_eq!(lib.list(1)[0].state, MeetingState::Done);
}

#[test]
fn a_timed_recognizer_hears_context_but_owns_each_word_once() {
    let tmp = TempDir::new("pipeline-timed");
    let lib = Library::open(tmp.path()).unwrap();
    let log = EventLog::open(tmp.path()).unwrap();
    let rec = Recording::new(&lib, &[Track::Mic]);
    rec.session(0, 1);
    rec.segment(
        "mic",
        1,
        0,
        &speech(&[
            (1.0, false),
            (1.5, true),
            (1.0, false),
            (1.5, true),
            (2.0, false),
        ]),
    );
    rec.stop(7000);
    let options = PipelineOptions {
        timed: Some(Arc::new(Bursts)),
        timing: fast(),
        ..PipelineOptions::new(Arc::new(Offline))
    };
    let handle = Pipeline::start(rec.dir.clone(), log.clone(), options);
    wait_for_state(&handle, |s| *s == PipelineState::Done);
    // The second window starts at 2.9 s and hears from 2.3 s: it hears the end of the first
    // burst too (w0), but that word belongs to the first window. Its own word starts 1.2 s into
    // what it heard.
    let found: Vec<(u64, u64, String)> = passages(&events(&log, &rec.id()))
        .into_iter()
        .map(|(_, start, end, text, _, _)| (start, end, text))
        .collect();
    assert_eq!(
        found,
        vec![(1000, 2500, "w1000".into()), (3500, 5000, "w1200".into())]
    );
    // The word timings are kept for later speaker labels.
    let stored = Transcript::open(rec.dir.path())
        .unwrap()
        .passages()
        .unwrap();
    assert_eq!(stored[1].tokens[0].text, " w1200");
    assert!((stored[1].tokens[0].start - 3.5).abs() < 0.011);
}

#[test]
fn passages_follow_a_growing_segment_and_late_dictation_makes_a_new_revision() {
    let tmp = TempDir::new("pipeline-live");
    let lib = Library::open(tmp.path()).unwrap();
    let log = EventLog::open(tmp.path()).unwrap();
    let rec = Recording::new(&lib, &[Track::Mic]);
    rec.session(0, 1);
    let mut mic = rec.open_segment("mic", 1, 0);
    mic.append(&speech(&[(2.0, true), (0.5, false)])).unwrap();
    let handle = Pipeline::start(rec.dir.clone(), log.clone(), echo());
    std::thread::sleep(Duration::from_millis(200));
    assert!(
        passages(&events(&log, &rec.id())).is_empty(),
        "the pause isn't long enough yet"
    );
    mic.append(&speech(&[(0.7, false)])).unwrap();
    let id = "mic-000000000".to_owned();
    wait_until("the first passage", Duration::from_secs(10), || {
        let found = passages(&events(&log, &rec.id()));
        (!found.is_empty()).then_some(())
    });
    assert_eq!(
        passages(&events(&log, &rec.id())),
        vec![(id.clone(), 0, 2400, "heard 2400 ms".into(), false, 1)]
    );

    // The app's dictation lines arrive after the passage was sent.
    rec.line(json!({"kind":"dictation","t":200,"state":"start"}));
    rec.line(json!({"kind":"dictation","t":1800,"state":"end"}));
    wait_until("the second revision", Duration::from_secs(10), || {
        (passages(&events(&log, &rec.id())).len() == 2).then_some(())
    });
    rec.close_segment(mic, "mic", 1, 0);
    rec.stop(3200);
    wait_for_state(&handle, |s| *s == PipelineState::Done);
    let all = events(&log, &rec.id());
    assert_eq!(
        passages(&all),
        vec![
            (id.clone(), 0, 2400, "heard 2400 ms".into(), false, 1),
            (id, 0, 2400, "heard 2400 ms".into(), true, 2),
        ]
    );
    assert_no_repeats(&all);
    let snapshot = lib.get(&rec.id(), &log).unwrap();
    assert_eq!(snapshot["passages"][0]["revision"], 2);
}

#[test]
fn recognition_waits_while_the_user_dictates() {
    let tmp = TempDir::new("pipeline-yield");
    let lib = Library::open(tmp.path()).unwrap();
    let log = EventLog::open(tmp.path()).unwrap();
    let rec = Recording::new(&lib, &[Track::Mic]);
    rec.session(0, 1);
    let mut mic = rec.open_segment("mic", 1, 0);
    mic.append(&speech(&[(2.0, true), (1.5, false)])).unwrap();
    rec.line(json!({"kind":"dictation","t":3400,"state":"start"}));
    let stt = Arc::new(Echo::default());
    let options = PipelineOptions {
        timing: fast(),
        ..PipelineOptions::new(stt.clone())
    };
    let handle = Pipeline::start(rec.dir.clone(), log.clone(), options);
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(stt.calls.load(Ordering::SeqCst), 0, "dictation comes first");
    rec.line(json!({"kind":"dictation","t":3450,"state":"end"}));
    wait_until("the passage", Duration::from_secs(10), || {
        (stt.calls.load(Ordering::SeqCst) > 0).then_some(())
    });
    rec.close_segment(mic, "mic", 1, 0);
    rec.stop(3500);
    wait_for_state(&handle, |s| *s == PipelineState::Done);
    let all = events(&log, &rec.id());
    assert!(!passages(&all)[0].4, "the dictation came after the passage");
    let marks = of(&all, "mark");
    assert_eq!(marks[0]["id"], "dict-3400");
}

#[test]
fn a_window_ends_where_the_track_loses_its_device() {
    let tmp = TempDir::new("pipeline-gap");
    let lib = Library::open(tmp.path()).unwrap();
    let log = EventLog::open(tmp.path()).unwrap();
    let rec = Recording::new(&lib, &[Track::Mic]);
    rec.session(0, 1);
    // The headset goes mid-sentence at 1.5 s and is back at 3 s.
    rec.segment("mic", 1, 0, &speech(&[(1.5, true)]));
    rec.line(json!({"kind":"device_lost","t":1500,"track":"mic","error":"gone"}));
    rec.line(
        json!({"kind":"device","t":3000,"track":"mic","device":"Headset","reason":"reconnected"}),
    );
    rec.segment("mic", 2, 3000, &speech(&[(2.0, true), (1.0, false)]));
    rec.stop(6000);
    let handle = Pipeline::start(rec.dir.clone(), log.clone(), echo());
    wait_for_state(&handle, |s| *s == PipelineState::Done);
    let all = events(&log, &rec.id());
    let found: Vec<(u64, u64, String)> = passages(&all)
        .into_iter()
        .map(|(_, start, end, text, _, _)| (start, end, text))
        .collect();
    assert_eq!(
        found,
        vec![
            (0, 1500, "heard 1500 ms".into()),
            (3000, 5400, "heard 2400 ms".into())
        ]
    );
    let marks: Vec<(String, Value)> = of(&all, "mark")
        .iter()
        .map(|m| (m["id"].as_str().unwrap().to_owned(), m["until"].clone()))
        .collect();
    assert_eq!(
        marks,
        vec![
            ("dev-mic-1500".to_owned(), Value::Null),
            ("dev-mic-3000".to_owned(), Value::Null),
            ("gap-mic-1500".to_owned(), json!(3000)),
        ]
    );
}

#[test]
fn a_meeting_that_is_removed_stops_its_pipeline() {
    let tmp = TempDir::new("pipeline-removed");
    let lib = Library::open(tmp.path()).unwrap();
    let log = EventLog::open(tmp.path()).unwrap();
    let rec = finished_recording(&lib);
    log.remove_meeting(&rec.id()).unwrap();
    let handle = Pipeline::start(rec.dir.clone(), log.clone(), echo());
    wait_for_state(&handle, |s| *s == PipelineState::Stopped);
    assert_eq!(events(&log, &rec.id()).len(), 1, "only meeting.removed");
}
