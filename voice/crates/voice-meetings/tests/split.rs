//! Splitting the microphone of a stopped meeting into voices (`speakers.split`), with the
//! scripted diarizer instead of the NeMo worker: which voice stays the user, which passages move,
//! passages cut where the voice changes, the events Rukoo gets, a split that is stored and never
//! runs twice, failures and stops that leave the meeting as it was, and passages written after a
//! split.
//!
//! The microphone is synthetic: each hidden speaker is a square wave of its own loudness, which
//! the scripted diarizer hears, and which the test knows from the script.

mod common;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::*;
use serde_json::{json, Value};
use voice_bridge::{EventLog, Stored};
use voice_core::speakers::Diarizer;
use voice_meetings::transcript::SPLIT_SENT_KEY;
use voice_meetings::{
    catch_up_split, microphone_end, split_microphone, split_voices, FollowerTiming, Labels,
    Library, MeetingDir, Pipeline, PipelineOptions, PipelineState, SplitError, Timing, Transcript,
};
use voice_protocol::Track;

fn fast() -> Timing {
    Timing {
        poll: Duration::from_millis(10),
        busy_poll: Duration::from_millis(1),
        retry_first: Duration::from_millis(10),
        retry_max: Duration::from_millis(40),
        attempts_after_stop: 3,
    }
}

/// Orukeet-like word timings from [`Bursts`]: one passage per burst of sound.
fn timed() -> PipelineOptions {
    PipelineOptions {
        timed: Some(Arc::new(Bursts)),
        timing: fast(),
        ..PipelineOptions::new(Arc::new(Offline))
    }
}

fn length_ms(pieces: &[(f64, Option<usize>)]) -> u64 {
    (pieces.iter().map(|p| p.0).sum::<f64>() * 1000.0).round() as u64
}

/// A stopped microphone-only recording of `pieces`, with dictation over each `(start, end)` ms.
fn recorded(lib: &Library, pieces: &[(f64, Option<usize>)], dictation: &[(u64, u64)]) -> Recording {
    let rec = Recording::new(lib, &[Track::Mic]);
    rec.session(0, 1);
    rec.segment("mic", 1, 0, &voices(pieces));
    for &(start, end) in dictation {
        rec.line(json!({"kind":"dictation","t":start,"state":"start"}));
        rec.line(json!({"kind":"dictation","t":end,"state":"end"}));
    }
    rec.stop(length_ms(pieces));
    rec
}

/// Transcribes a recording until it is `done`.
fn transcribe(rec: &Recording, log: &EventLog, opts: PipelineOptions) {
    let handle = Pipeline::start(rec.dir.clone(), log.clone(), opts);
    wait_for_state(&handle, PipelineState::is_final);
    assert_eq!(handle.state(), PipelineState::Done);
    handle.shutdown();
}

/// A microphone made of `(seconds, voice)` pieces, and the dictation over it in `(start, end)` ms.
type Microphone = (Vec<(f64, Option<usize>)>, Vec<(u64, u64)>);

/// The user (0) dictates, a second voice (1) and a third (2) share the microphone, and the
/// second voice speaks during a short dictation too.
fn three_at_the_microphone() -> Microphone {
    let pieces = vec![
        (0.5, None),
        (3.0, Some(0)), // 0.5-3.5 s, dictated
        (1.5, None),
        (2.5, Some(1)), // 5-7.5 s
        (1.5, None),
        (3.0, Some(0)), // 9-12 s
        (1.5, None),
        (2.0, Some(2)), // 13.5-15.5 s
        (1.5, None),
        (1.0, Some(1)), // 17-18 s, dictated
        (1.5, None),
        (2.0, Some(0)), // 19.5-21.5 s
        (1.0, None),
    ];
    (pieces, vec![(500, 3_500), (17_000, 18_000)])
}

fn no_stop() -> AtomicBool {
    AtomicBool::new(false)
}

fn split(
    dir: &MeetingDir,
    log: &EventLog,
    d: &ScriptedDiarizer,
    stop: &AtomicBool,
) -> Result<u64, SplitError> {
    split_microphone(dir, log, d, &FollowerTiming::default(), stop, &|_, _| {})
}

/// The last revision of each microphone passage, by start: (start, end, speaker, revision,
/// dictation).
fn mic_passages(events: &[Stored]) -> Vec<(u64, u64, String, u64, bool)> {
    let mut last: std::collections::BTreeMap<String, &Value> = Default::default();
    for p in of(events, "passage") {
        if p["track"] == "mic" {
            last.insert(p["id"].as_str().unwrap().to_owned(), p);
        }
    }
    let mut list: Vec<(u64, u64, String, u64, bool)> = last
        .values()
        .map(|p| {
            (
                p["start"].as_u64().unwrap(),
                p["end"].as_u64().unwrap(),
                p["speaker"].as_str().unwrap().to_owned(),
                p["revision"].as_u64().unwrap(),
                p["dictation"].as_bool().unwrap(),
            )
        })
        .collect();
    list.sort();
    list
}

/// Who each microphone passage belongs to after the split: (hidden speaker, speaker, dictation).
fn who_has_what(
    events: &[Stored],
    pieces: &[(f64, Option<usize>)],
) -> Vec<(Option<usize>, String, bool)> {
    let timeline = timeline_of(pieces, 0);
    mic_passages(events)
        .into_iter()
        .map(|(start, end, speaker, _, dictation)| (who(&timeline, start, end), speaker, dictation))
        .collect()
}

#[test]
fn a_split_moves_the_other_voices_passages_and_keeps_the_user_and_dictation_on_mic() {
    let tmp = TempDir::new("split");
    let lib = Library::open(tmp.path()).unwrap();
    let log = EventLog::open(tmp.path()).unwrap();
    let (pieces, dictation) = three_at_the_microphone();
    let rec = recorded(&lib, &pieces, &dictation);
    transcribe(&rec, &log, timed());
    let before = events(&log, &rec.id());
    assert_eq!(
        mic_passages(&before).len(),
        6,
        "{:?}",
        mic_passages(&before)
    );

    let d = ScriptedDiarizer::new();
    let seen = Mutex::new(Vec::new());
    let voices = split_microphone(
        &rec.dir,
        &log,
        &d,
        &FollowerTiming::default(),
        &no_stop(),
        &|at, end| seen.lock().unwrap().push((at, end)),
    )
    .unwrap();
    assert_eq!(voices, 3);

    // As fast as the stream takes it, from 0 to the end of the track.
    let seen = seen.into_inner().unwrap();
    let end = length_ms(&pieces);
    assert_eq!(seen.first(), Some(&(0, end)));
    assert_eq!(seen.last(), Some(&(end, end)));
    assert!(seen.windows(2).all(|w| w[0].0 <= w[1].0), "{seen:?}");
    assert_eq!(d.script().opens, 1);
    assert!(
        d.script().zero_samples > 0,
        "the gaps and the end were padded"
    );

    let after = events(&log, &rec.id());
    let new = &after[before.len()..];
    // The voices first, then the passages that moved.
    let kinds: Vec<&str> = new.iter().map(|e| e.event.as_str()).collect();
    assert_eq!(kinds, ["speaker", "speaker", "passage", "passage"]);
    assert_eq!(
        of(new, "speaker"),
        [
            &json!({"id": "mic-2", "track": "mic", "label": "Microphone 2"}),
            &json!({"id": "mic-3", "track": "mic", "label": "Microphone 3"}),
        ]
    );
    for p in of(new, "passage") {
        assert_eq!(p["revision"], 2, "{p}");
        assert_eq!(p["dictation"], false, "{p}");
    }
    assert_eq!(
        who_has_what(&after, &pieces),
        [
            (Some(0), "mic".into(), true),
            (Some(1), "mic-2".into(), false),
            (Some(0), "mic".into(), false),
            (Some(2), "mic-3".into(), false),
            // The second voice had the majority, but the user dictated.
            (Some(1), "mic".into(), true),
            (Some(0), "mic".into(), false),
        ]
    );
    assert_no_repeats(&after);

    // meeting.get has the new voices and the passages where they moved.
    let snapshot = lib.get(&rec.id(), &log).unwrap();
    let speakers: Vec<&str> = snapshot["speakers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["id"].as_str().unwrap())
        .collect();
    assert_eq!(speakers, ["mic", "mic-2", "mic-3"]);
    let moved: Vec<&str> = snapshot["passages"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|p| p["speaker"].as_str().filter(|s| *s != "mic"))
        .collect();
    assert_eq!(moved, ["mic-2", "mic-3"]);

    // The split is stored: asked again, and after reopening, it answers the same and never
    // splits again.
    assert_eq!(split(&rec.dir, &log, &d, &no_stop()).unwrap(), 3);
    assert_eq!(d.script().opens, 1);
    assert_eq!(events(&log, &rec.id()).len(), after.len());
    assert_eq!(split_voices(&rec.dir).unwrap(), Some(3));
    let t = Transcript::open(rec.dir.path()).unwrap();
    let turns = t.turns(Track::Mic, 0, u64::MAX).unwrap();
    let mut ids: Vec<&str> = turns.iter().map(|t| t.speaker.as_str()).collect();
    ids.sort();
    ids.dedup();
    assert_eq!(ids, ["mic", "mic-2", "mic-3"]);
    assert!(t.turns(Track::Call, 0, u64::MAX).unwrap().is_empty());
    let epochs = t.epochs().unwrap();
    assert_eq!(epochs.len(), 1);
    assert_eq!(
        (epochs[0].track, epochs[0].reason.as_str()),
        (Track::Mic, "split")
    );

    // A pipeline that runs over the meeting again sends nothing twice.
    transcribe(&rec, &log, timed());
    assert_eq!(events(&log, &rec.id()).len(), after.len());
}

#[test]
fn the_voice_heard_most_while_the_user_dictated_is_the_user() {
    let tmp = TempDir::new("split-dictation");
    let lib = Library::open(tmp.path()).unwrap();
    let log = EventLog::open(tmp.path()).unwrap();
    // The other voice talks far longer, but only the user is heard while dictating.
    let pieces = vec![
        (0.5, None),
        (2.0, Some(0)), // 0.5-2.5 s, dictated
        (1.5, None),
        (6.0, Some(1)), // 4-10 s
        (1.5, None),
        (2.0, Some(0)), // 11.5-13.5 s
        (1.5, None),
        (6.0, Some(1)), // 15-21 s
        (1.0, None),
    ];
    let rec = recorded(&lib, &pieces, &[(500, 2_500)]);
    transcribe(&rec, &log, timed());
    let d = ScriptedDiarizer::new();
    assert_eq!(split(&rec.dir, &log, &d, &no_stop()).unwrap(), 2);
    assert_eq!(
        who_has_what(&events(&log, &rec.id()), &pieces),
        [
            (Some(0), "mic".into(), true),
            (Some(1), "mic-2".into(), false),
            (Some(0), "mic".into(), false),
            (Some(1), "mic-2".into(), false),
        ]
    );

    // Without dictation the voice heard longest is the user.
    let other = recorded(&lib, &pieces, &[]);
    transcribe(&other, &log, timed());
    assert_eq!(split(&other.dir, &log, &d, &no_stop()).unwrap(), 2);
    assert_eq!(
        who_has_what(&events(&log, &other.id()), &pieces),
        [
            (Some(0), "mic-2".into(), false),
            (Some(1), "mic".into(), false),
            (Some(0), "mic-2".into(), false),
            (Some(1), "mic".into(), false),
        ]
    );
}

#[test]
fn one_voice_at_the_microphone_sends_nothing_and_stays_split() {
    let tmp = TempDir::new("split-one");
    let lib = Library::open(tmp.path()).unwrap();
    let log = EventLog::open(tmp.path()).unwrap();
    let pieces = vec![
        (0.5, None),
        (3.0, Some(0)),
        (1.5, None),
        (3.0, Some(0)),
        (1.0, None),
    ];
    let rec = recorded(&lib, &pieces, &[]);
    transcribe(&rec, &log, timed());
    let before = events(&log, &rec.id()).len();
    let d = ScriptedDiarizer::with(Script::like_the_runtime);
    assert_eq!(split(&rec.dir, &log, &d, &no_stop()).unwrap(), 1);
    assert_eq!(events(&log, &rec.id()).len(), before, "nothing was sent");
    assert_eq!(split(&rec.dir, &log, &d, &no_stop()).unwrap(), 1);
    assert_eq!(d.script().opens, 1, "split once");
}

/// Who has what after [`three_at_the_microphone`] is split.
fn three_split() -> Vec<(Option<usize>, String, bool)> {
    vec![
        (Some(0), "mic".into(), true),
        (Some(1), "mic-2".into(), false),
        (Some(0), "mic".into(), false),
        (Some(2), "mic-3".into(), false),
        (Some(1), "mic".into(), true),
        (Some(0), "mic".into(), false),
    ]
}

/// Splits as a Voice that quit right after storing the split would have: `transcript.db` has
/// the split, and its events went to `lost` instead of Rukoo's `log`. Returns `log`'s events.
fn split_without_its_events(
    rec: &Recording,
    log: &EventLog,
    lost: &EventLog,
    d: &ScriptedDiarizer,
) -> Vec<Stored> {
    let before = events(log, &rec.id());
    assert_eq!(split(&rec.dir, lost, d, &no_stop()).unwrap(), 3);
    assert_eq!(split_voices(&rec.dir).unwrap(), Some(3));
    assert_eq!(events(log, &rec.id()).len(), before.len(), "{before:?}");
    before
}

/// The split's events in Rukoo's log after `before`: the voices first, then the passages that
/// moved, each once.
fn assert_split_sent(
    log: &EventLog,
    rec: &Recording,
    before: &[Stored],
    pieces: &[(f64, Option<usize>)],
) {
    let after = events(log, &rec.id());
    let kinds: Vec<&str> = after[before.len()..]
        .iter()
        .map(|e| e.event.as_str())
        .collect();
    assert_eq!(kinds, ["speaker", "speaker", "passage", "passage"]);
    assert_eq!(who_has_what(&after, pieces), three_split());
    assert_no_repeats(&after);
}

#[test]
fn a_split_whose_events_never_went_out_sends_them_at_the_next_start_or_before_done() {
    let tmp = TempDir::new("split-owed");
    let lib = Library::open(tmp.path()).unwrap();
    let log = EventLog::open(tmp.path()).unwrap();
    let lost = EventLog::open(&tmp.path().join("lost")).unwrap();
    let (pieces, dictation) = three_at_the_microphone();
    let d = ScriptedDiarizer::new();

    // Voice's next start sends them, once.
    let rec = recorded(&lib, &pieces, &dictation);
    transcribe(&rec, &log, timed());
    let before = split_without_its_events(&rec, &log, &lost, &d);
    assert_eq!(catch_up_split(&rec.dir, &log).unwrap(), 4);
    assert_split_sent(&log, &rec, &before, &pieces);
    let sent = events(&log, &rec.id()).len();
    assert_eq!(catch_up_split(&rec.dir, &log).unwrap(), 0);
    assert_eq!(split(&rec.dir, &log, &d, &no_stop()).unwrap(), 3);
    assert_eq!(events(&log, &rec.id()).len(), sent);

    // Or speakers.split asks again first: it sends them before it answers done, without
    // splitting again.
    let other = recorded(&lib, &pieces, &dictation);
    transcribe(&other, &log, timed());
    let before = split_without_its_events(&other, &log, &lost, &d);
    let opens = d.script().opens;
    assert_eq!(split(&other.dir, &log, &d, &no_stop()).unwrap(), 3);
    assert_eq!(d.script().opens, opens, "split once");
    assert_split_sent(&log, &other, &before, &pieces);
    assert_eq!(catch_up_split(&other.dir, &log).unwrap(), 0);

    // A meeting this log has no events of stays out of it, and the start reads a meeting that
    // was never transcribed without creating its transcript.db.
    let elsewhere = recorded(&lib, &pieces, &dictation);
    transcribe(&elsewhere, &lost, timed());
    assert_eq!(split(&elsewhere.dir, &lost, &d, &no_stop()).unwrap(), 3);
    assert_eq!(catch_up_split(&elsewhere.dir, &log).unwrap(), 0);
    assert!(events(&log, &elsewhere.id()).is_empty());
    let untouched = recorded(&lib, &pieces, &[]);
    assert_eq!(catch_up_split(&untouched.dir, &log).unwrap(), 0);
    assert!(!untouched.dir.path().join("transcript.db").exists());
}

/// Runs SQL on the event log's `bridge.db`, as a Voice that stopped halfway would leave it.
fn log_sql(log: &EventLog, statement: &str) {
    let conn = rusqlite::Connection::open(log.path()).unwrap();
    conn.execute_batch(statement).unwrap();
}

#[test]
fn a_start_reads_only_the_mark_of_a_split_whose_events_all_went_out() {
    let tmp = TempDir::new("split-sent");
    let lib = Library::open(tmp.path()).unwrap();
    let log = EventLog::open(tmp.path()).unwrap();
    let (pieces, dictation) = three_at_the_microphone();
    let rec = recorded(&lib, &pieces, &dictation);
    transcribe(&rec, &log, timed());
    assert_eq!(
        split(&rec.dir, &log, &ScriptedDiarizer::new(), &no_stop()).unwrap(),
        3
    );
    let sent = events(&log, &rec.id()).len();

    // Every microphone passage moves to a revision the log never got, so a start that read the
    // passages would send all six. The mark says the split's events went out: it sends none.
    sql(
        &rec,
        "UPDATE passages SET revision = revision + 1 WHERE track = 'mic'",
    );
    assert_eq!(catch_up_split(&rec.dir, &log).unwrap(), 0);
    assert_eq!(events(&log, &rec.id()).len(), sent);

    // A log whose head is below the mark lost the split's last events, as to a power cut: the
    // start reads the split again and sends what the log lacks, then marks it again.
    let ahead = format!("{}:{}", log.instance(), log.head() + 100);
    sql(
        &rec,
        &format!("UPDATE meta SET value = '{ahead}' WHERE key = '{SPLIT_SENT_KEY}'"),
    );
    assert_eq!(catch_up_split(&rec.dir, &log).unwrap(), 6);
    assert_no_repeats(&events(&log, &rec.id()));
    assert_eq!(catch_up_split(&rec.dir, &log).unwrap(), 0);
}

#[test]
fn a_split_that_stopped_halfway_through_its_events_sends_the_rest_at_the_next_start() {
    let tmp = TempDir::new("split-halfway");
    let lib = Library::open(tmp.path()).unwrap();
    let log = EventLog::open(tmp.path()).unwrap();
    let (pieces, dictation) = three_at_the_microphone();
    let rec = recorded(&lib, &pieces, &dictation);
    transcribe(&rec, &log, timed());
    let before = events(&log, &rec.id());
    assert_eq!(
        split(&rec.dir, &log, &ScriptedDiarizer::new(), &no_stop()).unwrap(),
        3
    );

    // Voice stopped after the split's first event: the log lacks the other three, and the split
    // has no mark.
    let first = events(&log, &rec.id())[before.len()].seq;
    log_sql(&log, &format!("DELETE FROM events WHERE seq > {first}"));
    sql(
        &rec,
        &format!("DELETE FROM meta WHERE key = '{SPLIT_SENT_KEY}'"),
    );
    assert_eq!(catch_up_split(&rec.dir, &log).unwrap(), 3);
    assert_split_sent(&log, &rec, &before, &pieces);
    assert_eq!(catch_up_split(&rec.dir, &log).unwrap(), 0);
}

/// Nothing a split wrote: no voices, no microphone turns, no epoch, passages as they were.
fn assert_untouched(rec: &Recording, log: &EventLog, before: &[Stored]) {
    assert_eq!(split_voices(&rec.dir).unwrap(), None);
    let t = Transcript::open(rec.dir.path()).unwrap();
    assert!(t.turns(Track::Mic, 0, u64::MAX).unwrap().is_empty());
    assert!(t.epochs().unwrap().is_empty());
    assert!(t
        .passages()
        .unwrap()
        .iter()
        .all(|p| p.passage.revision == 1 && p.passage.speaker.as_deref() == Some("mic")));
    assert_eq!(events(log, &rec.id()).len(), before.len());
}

#[test]
fn a_worker_that_fails_or_a_stop_leaves_the_meeting_as_it_was_and_the_next_split_starts_over() {
    let tmp = TempDir::new("split-fail");
    let lib = Library::open(tmp.path()).unwrap();
    let log = EventLog::open(tmp.path()).unwrap();
    let (pieces, dictation) = three_at_the_microphone();
    let rec = recorded(&lib, &pieces, &dictation);
    transcribe(&rec, &log, timed());
    let before = events(&log, &rec.id());

    let crashing = ScriptedDiarizer::with(|s| s.crash_on = vec![5]);
    match split(&rec.dir, &log, &crashing, &no_stop()) {
        Err(SplitError::Worker(e)) => assert!(e.message.contains("crashed"), "{e:?}"),
        other => panic!("not a worker failure: {other:?}"),
    }
    assert_untouched(&rec, &log, &before);

    // A stop during the split, as when Voice quits.
    let stop = Arc::new(AtomicBool::new(false));
    let stopping = Arc::clone(&stop);
    let pushes = ScriptedDiarizer::new();
    let watched = pushes.clone();
    let result = split_microphone(
        &rec.dir,
        &log,
        &pushes,
        &FollowerTiming::default(),
        &stop,
        &move |at, _| {
            if at >= 8_000 {
                stopping.store(true, Ordering::SeqCst);
            }
        },
    );
    assert!(matches!(result, Err(SplitError::Stopped)), "{result:?}");
    assert!(watched.script().finishes == 0, "the stream never finished");
    assert_untouched(&rec, &log, &before);

    // The next split starts over and finishes.
    let working = ScriptedDiarizer::new();
    assert_eq!(split(&rec.dir, &log, &working, &no_stop()).unwrap(), 3);
}

/// Word timings from [`Bursts`], and the call labelled by `d` as Nemotron would label it.
fn labelled(d: &ScriptedDiarizer) -> PipelineOptions {
    PipelineOptions {
        labels: Labels::Local {
            diarizer: Arc::new(d.clone()),
        },
        speakers: FollowerTiming {
            poll: Duration::from_millis(5),
            backoff: vec![Duration::from_millis(10)],
            ..FollowerTiming::default()
        },
        ..timed()
    }
}

/// A track as the scripted diarizer plays it: stretches of seconds, each silent or one voice.
type Spans = Vec<(f64, Option<usize>)>;

/// The user (0) and another voice (1) at the microphone, which also hears the call's voice (3)
/// through the speakers while the call speaks, 9-12 s. The microphone first, then the call.
fn the_call_at_the_microphone() -> (Spans, Spans) {
    let microphone = vec![
        (0.5, None),
        (3.0, Some(0)), // 0.5-3.5 s
        (1.5, None),
        (2.5, Some(1)), // 5-7.5 s
        (1.5, None),
        (3.0, Some(3)), // 9-12 s, the call through the speakers
        (1.5, None),
        (3.0, Some(0)), // 13.5-16.5 s
        (1.5, None),
        (2.0, Some(1)), // 18-20 s
        (1.0, None),
    ];
    let call = vec![(9.0, None), (3.0, Some(3)), (9.0, None)];
    (microphone, call)
}

#[test]
fn the_call_heard_at_the_microphone_doesn_t_become_a_voice_there() {
    let tmp = TempDir::new("split-bleed");
    let lib = Library::open(tmp.path()).unwrap();
    let log = EventLog::open(tmp.path()).unwrap();
    let (microphone, call) = the_call_at_the_microphone();
    let labels = ScriptedDiarizer::new();
    // Gated by the call's passages in a meeting without labels, by its turns in one that
    // Nemotron labelled.
    for (gate, opts) in [("passages", timed()), ("turns", labelled(&labels))] {
        let rec = Recording::new(&lib, &[Track::Mic, Track::Call]);
        rec.session(0, 1);
        rec.segment("mic", 1, 0, &voices(&microphone));
        rec.segment("call", 1, 0, &voices(&call));
        rec.stop(length_ms(&microphone));
        transcribe(&rec, &log, opts);
        let call_turns = Transcript::open(rec.dir.path())
            .unwrap()
            .turns(Track::Call, 0, u64::MAX)
            .unwrap();
        assert_eq!(call_turns.is_empty(), gate == "passages", "{call_turns:?}");

        let d = ScriptedDiarizer::new();
        assert_eq!(split(&rec.dir, &log, &d, &no_stop()).unwrap(), 2, "{gate}");
        let after = events(&log, &rec.id());
        assert_eq!(
            who_has_what(&after, &microphone),
            [
                (Some(0), "mic".into(), false),
                (Some(1), "mic-2".into(), false),
                // The call's voice, silenced before the diarizer heard it: no voice of its own.
                (Some(3), "mic".into(), false),
                (Some(0), "mic".into(), false),
                (Some(1), "mic-2".into(), false),
            ],
            "{gate}"
        );
        let speakers: Vec<&Value> = of(&after, "speaker")
            .into_iter()
            .filter(|s| s["track"] == "mic")
            .collect();
        assert_eq!(speakers.len(), 2, "{gate}: {speakers:?}");
        assert_no_repeats(&after);
        let mic_turns = Transcript::open(rec.dir.path())
            .unwrap()
            .turns(Track::Mic, 8_800, 12_200)
            .unwrap();
        assert!(mic_turns.is_empty(), "{gate}: {mic_turns:?}");
    }
}

#[test]
fn a_split_needs_a_stopped_meeting_with_its_microphone_audio() {
    let tmp = TempDir::new("split-refused");
    let lib = Library::open(tmp.path()).unwrap();
    let log = EventLog::open(tmp.path()).unwrap();
    let d = ScriptedDiarizer::new();
    let pieces = vec![(0.5, None), (2.0, Some(0)), (1.0, None)];

    // Still recording: no `stop` yet.
    let live = Recording::new(&lib, &[Track::Mic]);
    live.session(0, 1);
    live.segment("mic", 1, 0, &voices(&pieces));
    assert!(matches!(
        split(&live.dir, &log, &d, &no_stop()),
        Err(SplitError::Recording)
    ));

    // The microphone's audio went with retention.
    let rec = recorded(&lib, &pieces, &[]);
    assert_eq!(microphone_end(&rec.dir).unwrap(), 3_500);
    std::fs::remove_dir_all(rec.dir.audio_dir()).unwrap();
    assert_eq!(microphone_end(&rec.dir).unwrap(), 0);
    assert!(matches!(
        split(&rec.dir, &log, &d, &no_stop()),
        Err(SplitError::NoAudio)
    ));

    // A meeting without a microphone track has nothing to split.
    let call = Recording::new(&lib, &[Track::Call]);
    call.session(0, 1);
    call.segment("call", 1, 0, &voices(&pieces));
    call.stop(3_500);
    assert_eq!(microphone_end(&call.dir).unwrap(), 0);
    assert!(matches!(
        split(&call.dir, &log, &d, &no_stop()),
        Err(SplitError::NoAudio)
    ));
    assert_eq!(d.script().opens, 0, "no worker for any of them");
}

/// The user (0) says a word and another voice (1) answers 0.4 s later: too soon to end the
/// window or the passage, so the pipeline makes one passage of both, which voice 1 holds most
/// of. Then the user talks alone, longer, so the user is the voice heard longest.
fn an_exchange() -> Vec<(f64, Option<usize>)> {
    vec![
        (0.5, None),
        (1.0, Some(0)), // 0.5-1.5 s
        (0.4, None),
        (3.5, Some(1)), // 1.9-5.4 s, the same passage
        (1.5, None),
        (5.0, Some(0)), // 6.9-11.9 s
        (1.0, None),
    ]
}

/// The id of the exchange's first passage, the one both voices share.
const SHARED: &str = "mic-000000500";

/// The microphone passages in `transcript.db`, by start: (id, start, end, text, speaker,
/// revision).
fn stored(rec: &Recording) -> Vec<(String, u64, u64, String, String, u64)> {
    Transcript::open(rec.dir.path())
        .unwrap()
        .passages()
        .unwrap()
        .into_iter()
        .map(|s| s.passage)
        .filter(|p| p.track == Track::Mic)
        .map(|p| (p.id, p.start, p.end, p.text, p.speaker.unwrap(), p.revision))
        .collect()
}

/// Runs SQL on a meeting's `transcript.db`, as a damaged or older store would hold it.
fn sql(rec: &Recording, statement: &str) {
    let conn = rusqlite::Connection::open(rec.dir.path().join("transcript.db")).unwrap();
    conn.execute_batch(statement).unwrap();
}

#[test]
fn a_passage_two_voices_share_is_cut_where_the_voice_changes() {
    let tmp = TempDir::new("split-cut");
    let lib = Library::open(tmp.path()).unwrap();
    let log = EventLog::open(tmp.path()).unwrap();
    let pieces = an_exchange();
    let rec = recorded(&lib, &pieces, &[]);
    transcribe(&rec, &log, timed());
    let before = events(&log, &rec.id());
    let last = stored(&rec)[1].clone();
    assert_eq!(
        stored(&rec),
        [
            (
                SHARED.into(),
                500,
                5_400,
                "w500 w1900".into(),
                "mic".into(),
                1
            ),
            last.clone(),
        ]
    );

    let d = ScriptedDiarizer::new();
    assert_eq!(split(&rec.dir, &log, &d, &no_stop()).unwrap(), 2);
    // The first piece keeps the passage's id at a new revision and stays the user's; the second
    // is a passage of its own at revision 1. Taken whole, the passage would have gone to voice 1.
    let cut = vec![
        (SHARED.into(), 500, 1_500, "w500".into(), "mic".into(), 2),
        (
            "mic-000001900".into(),
            1_900,
            5_400,
            "w1900".into(),
            "mic-2".into(),
            1,
        ),
        last,
    ];
    assert_eq!(stored(&rec), cut);
    let after = events(&log, &rec.id());
    let new: Vec<(&str, &Value)> = after[before.len()..]
        .iter()
        .map(|e| (e.event.as_str(), &e.data))
        .collect();
    assert_eq!(new.len(), 3, "{new:?}");
    assert_eq!(
        new[0],
        (
            "speaker",
            &json!({"id": "mic-2", "track": "mic", "label": "Microphone 2"})
        )
    );
    assert_eq!(
        (new[1].0, &new[1].1["id"], &new[1].1["revision"]),
        ("passage", &json!(SHARED), &json!(2))
    );
    assert_eq!(
        (new[2].0, &new[2].1["id"], &new[2].1["revision"]),
        ("passage", &json!("mic-000001900"), &json!(1))
    );
    assert_eq!(new[2].1["text"], "w1900");
    assert_eq!(new[2].1["dictation"], false);
    assert_no_repeats(&after);
    // The pieces keep their word timings: each has its own word.
    let t = Transcript::open(rec.dir.path()).unwrap();
    let words: Vec<Vec<String>> = t
        .passages()
        .unwrap()
        .iter()
        .take(2)
        .map(|s| s.tokens.iter().map(|w| w.text.clone()).collect())
        .collect();
    assert_eq!(words, [vec![" w500"], vec![" w1900"]]);
    drop(t);
    // meeting.get has the pieces.
    let snapshot = lib.get(&rec.id(), &log).unwrap();
    let ids: Vec<&str> = snapshot["passages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, [SHARED, "mic-000001900", cut[2].0.as_str()]);

    // A second split answers the same and sends nothing.
    assert_eq!(split(&rec.dir, &log, &d, &no_stop()).unwrap(), 2);
    assert_eq!(events(&log, &rec.id()).len(), after.len());
    // So does one after Voice opens the meeting again, and a pipeline over the meeting.
    drop(log);
    drop(lib);
    let lib = Library::open(tmp.path()).unwrap();
    let log = EventLog::open(tmp.path()).unwrap();
    let dir = lib.dir(&rec.id()).unwrap();
    assert_eq!(split(&dir, &log, &d, &no_stop()).unwrap(), 2);
    transcribe(&rec, &log, timed());
    assert_eq!(events(&log, &rec.id()).len(), after.len());
    assert_eq!(stored(&rec), cut);
    assert_eq!(d.script().opens, 1, "split once");
}

#[test]
fn passages_without_readable_word_timings_take_one_voice_whole() {
    let tmp = TempDir::new("split-untimed");
    let lib = Library::open(tmp.path()).unwrap();
    let log = EventLog::open(tmp.path()).unwrap();
    let pieces = an_exchange();
    let d = ScriptedDiarizer::new();

    // A recognizer without timings: one passage per window, the first over both voices.
    let text = recorded(&lib, &pieces, &[]);
    transcribe(
        &text,
        &log,
        PipelineOptions {
            timing: fast(),
            ..PipelineOptions::new(Arc::new(Echo::default()))
        },
    );
    let before = stored(&text);
    assert_eq!((before[0].1, before[0].4.as_str()), (0, "mic"));
    assert_eq!(split(&text.dir, &log, &d, &no_stop()).unwrap(), 2);
    let after = stored(&text);
    assert_eq!(after.len(), before.len(), "nothing cut: {after:?}");
    let moved = (before[0].0.clone(), 0, before[0].2, before[0].3.clone());
    assert_eq!(
        (
            after[0].0.clone(),
            after[0].1,
            after[0].2,
            after[0].3.clone()
        ),
        moved
    );
    assert_eq!((after[0].4.as_str(), after[0].5), ("mic-2", 2));

    // Word timings that can't be read, and ones that spell other words.
    for (name, tokens) in [
        ("unreadable", "'not json'"),
        (
            "other words",
            r#"'[[" Hello",0.5,1.5],[" there",1.9,5.4]]'"#,
        ),
    ] {
        let rec = recorded(&lib, &pieces, &[]);
        transcribe(&rec, &log, timed());
        sql(
            &rec,
            &format!("UPDATE passages SET tokens = {tokens} WHERE id = '{SHARED}'"),
        );
        assert_eq!(split(&rec.dir, &log, &d, &no_stop()).unwrap(), 2, "{name}");
        let after = stored(&rec);
        assert_eq!(after.len(), 2, "{name}: nothing cut: {after:?}");
        assert_eq!(
            after[0],
            (
                SHARED.into(),
                500,
                5_400,
                "w500 w1900".into(),
                "mic-2".into(),
                2
            ),
            "{name}"
        );
    }
}

#[test]
fn a_dictated_passage_is_never_cut() {
    let tmp = TempDir::new("split-dictated");
    let lib = Library::open(tmp.path()).unwrap();
    let log = EventLog::open(tmp.path()).unwrap();
    // The exchange while the user dictated, then voice 1 alone.
    let mut pieces = an_exchange();
    pieces.extend([(1.5, None), (2.0, Some(1)), (1.0, None)]);
    let rec = recorded(&lib, &pieces, &[(500, 1_500)]);
    transcribe(&rec, &log, timed());
    let before = stored(&rec);
    assert_eq!(before.len(), 3, "{before:?}");
    let d = ScriptedDiarizer::new();
    assert_eq!(split(&rec.dir, &log, &d, &no_stop()).unwrap(), 2);
    let after = stored(&rec);
    assert_eq!(after.len(), 3, "{after:?}");
    // The dictated passage stays whole and the user's, at its revision; voice 1 alone moved.
    assert_eq!(after[0], before[0]);
    let t = Transcript::open(rec.dir.path()).unwrap();
    assert!(t.passages().unwrap()[0].passage.dictation);
    assert_eq!(after[1], before[1]);
    assert_eq!((after[2].4.as_str(), after[2].5), ("mic-2", 2));
}

#[test]
fn a_piece_on_the_id_of_a_stored_passage_is_not_cut_off() {
    let tmp = TempDir::new("split-taken");
    let lib = Library::open(tmp.path()).unwrap();
    let log = EventLog::open(tmp.path()).unwrap();
    let rec = recorded(&lib, &an_exchange(), &[]);
    transcribe(&rec, &log, timed());
    // A passage already starts where the second piece would, so its id is taken. A pipeline
    // sends it, as it would any stored passage.
    sql(
        &rec,
        r#"INSERT INTO passages (id, track, speaker, start, "end", text, revision, dictation)
           VALUES ('mic-000001900', 'mic', 'mic', 1900, 1950, 'uh', 1, 0)"#,
    );
    transcribe(&rec, &log, timed());
    let before = stored(&rec);
    assert_eq!(before.len(), 3, "{before:?}");

    assert_eq!(
        split(&rec.dir, &log, &ScriptedDiarizer::new(), &no_stop()).unwrap(),
        2
    );
    let after = stored(&rec);
    // No cut there: the passage stays whole and takes the voice with a clear majority.
    assert_eq!(after.len(), 3, "{after:?}");
    assert_eq!(
        after[0],
        (
            SHARED.into(),
            500,
            5_400,
            "w500 w1900".into(),
            "mic-2".into(),
            2
        )
    );
    assert_eq!(after[1].0, "mic-000001900");
    assert_no_repeats(&events(&log, &rec.id()));
}

#[test]
fn passages_written_after_a_split_are_cut_as_the_split_cuts_them() {
    let tmp = TempDir::new("split-cut-later");
    let lib = Library::open(tmp.path()).unwrap();
    let log = EventLog::open(tmp.path()).unwrap();
    let pieces = an_exchange();

    // Transcribed, then split.
    let first = recorded(&lib, &pieces, &[]);
    transcribe(&first, &log, timed());
    split(&first.dir, &log, &ScriptedDiarizer::new(), &no_stop()).unwrap();

    // Split before anything was transcribed, then transcribed.
    let later = recorded(&lib, &pieces, &[]);
    let failing = Pipeline::start(
        later.dir.clone(),
        log.clone(),
        PipelineOptions {
            timing: fast(),
            ..PipelineOptions::new(Arc::new(Offline))
        },
    );
    wait_for_state(&failing, PipelineState::is_final);
    failing.shutdown();
    assert_eq!(
        split(&later.dir, &log, &ScriptedDiarizer::new(), &no_stop()).unwrap(),
        1
    );
    transcribe(&later, &log, timed());

    // The same passages, each at revision 1, since none had to change.
    let without_revision = |rec: &Recording| -> Vec<(String, u64, u64, String, String)> {
        stored(rec)
            .into_iter()
            .map(|(id, start, end, text, speaker, _)| (id, start, end, text, speaker))
            .collect()
    };
    assert_eq!(without_revision(&later), without_revision(&first));
    assert_eq!(stored(&later).len(), 3);
    assert!(
        stored(&later).iter().all(|p| p.5 == 1),
        "{:?}",
        stored(&later)
    );
    let all = events(&log, &later.id());
    let speaker = all
        .iter()
        .position(|e| e.event == "speaker" && e.data["id"] == "mic-2")
        .expect("mic-2");
    let passage = all
        .iter()
        .position(|e| e.event == "passage" && e.data["speaker"] == "mic-2")
        .unwrap();
    assert!(speaker < passage);
    assert_no_repeats(&all);
}

#[test]
fn passages_written_after_a_split_get_their_voice_from_the_stored_turns() {
    let tmp = TempDir::new("split-later");
    let lib = Library::open(tmp.path()).unwrap();
    let log = EventLog::open(tmp.path()).unwrap();
    let (pieces, dictation) = three_at_the_microphone();
    let rec = recorded(&lib, &pieces, &dictation);
    // Recognition fails after the stop: the meeting ends `failed` without a passage.
    let failing = Pipeline::start(
        rec.dir.clone(),
        log.clone(),
        PipelineOptions {
            timing: fast(),
            ..PipelineOptions::new(Arc::new(Offline))
        },
    );
    wait_for_state(&failing, PipelineState::is_final);
    assert!(matches!(failing.state(), PipelineState::Failed { .. }));
    failing.shutdown();
    assert!(mic_passages(&events(&log, &rec.id())).is_empty());

    // Split before anything was transcribed: nothing moves.
    let d: Arc<dyn Diarizer> = Arc::new(ScriptedDiarizer::new());
    assert_eq!(
        split_microphone(
            &rec.dir,
            &log,
            d.as_ref(),
            &FollowerTiming::default(),
            &no_stop(),
            &|_, _| {}
        )
        .unwrap(),
        1
    );
    let before = events(&log, &rec.id()).len();
    assert!(of(&events(&log, &rec.id()), "speaker")
        .iter()
        .all(|s| s["id"] == "mic"));

    // Voice transcribes the meeting again at its next start: the passages take their voices.
    transcribe(&rec, &log, timed());
    let all = events(&log, &rec.id());
    assert_eq!(
        who_has_what(&all, &pieces),
        [
            (Some(0), "mic".into(), true),
            (Some(1), "mic-2".into(), false),
            (Some(0), "mic".into(), false),
            (Some(2), "mic-3".into(), false),
            (Some(1), "mic".into(), true),
            (Some(0), "mic".into(), false),
        ]
    );
    // Each new voice reached Rukoo before its first passage.
    let new = &all[before..];
    for id in ["mic-2", "mic-3"] {
        let speaker = new
            .iter()
            .position(|e| e.event == "speaker" && e.data["id"] == id)
            .unwrap_or_else(|| panic!("no speaker {id}"));
        let passage = new
            .iter()
            .position(|e| e.event == "passage" && e.data["speaker"] == id)
            .unwrap();
        assert!(speaker < passage, "{id}");
        assert_eq!(
            new[speaker].data["label"],
            format!("Microphone {}", &id[4..])
        );
    }
    // Every passage came once, at revision 1: none had to move.
    assert!(mic_passages(&all).iter().all(|p| p.3 == 1));
    assert_no_repeats(&all);
    // The split stays what it was.
    assert_eq!(split_voices(&rec.dir).unwrap(), Some(1));
}
