//! Splitting the microphone of a stopped meeting into voices (`speakers.split`), with the
//! scripted diarizer instead of the NeMo worker: which voice stays the user, which passages move,
//! the events Rukoo gets, a split that is stored and never runs twice, failures and stops that
//! leave the meeting as it was, and passages written after a split.
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
use voice_meetings::{
    microphone_end, split_microphone, split_voices, FollowerTiming, Library, MeetingDir, Pipeline,
    PipelineOptions, PipelineState, SplitError, Timing, Transcript,
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
