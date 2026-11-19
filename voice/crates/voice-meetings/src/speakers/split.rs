//! Splitting the microphone into voices (`speakers.split` in voice/PROTOCOL.md): a batch run of
//! what the follower does live for the call, over the recorded microphone track of a stopped
//! meeting.
//!
//! The track goes to one diarizer stream as fast as the stream takes it, read by meeting time
//! the way the follower reads the call, with the follower's padding at gaps and at the end, its
//! labeller and its stream clock. Once the stream heard everything, the voice that is the user
//! keeps `mic`: the one heard most while the user dictated, else the one heard most. Every other
//! voice gets `mic-2`, `mic-3` and so on, in the order of its first turn. Each microphone passage
//! the user didn't dictate takes the voice with a clear majority of its time, the rule the call's
//! passages follow; one without a clear majority keeps `mic`.
//!
//! Nothing is written until the stream heard the whole track. Then the microphone's turns, the
//! passages that moved and the number of voices go into `transcript.db` in one transaction, and
//! the events follow through the event log the way the pipeline sends them: a `speaker` for each
//! voice that kept passages, then the passages' new revisions. A split that fails or is stopped
//! before that transaction leaves the meeting as it was, and the next one starts over; one that
//! stopped after it sends the events it still owes ([`send_split`]).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};

use voice_bridge::{EventLog, LogError};
use voice_core::speakers::{DiarError, DiarStream, Diarizer};
use voice_protocol::{events, Passage, Track};

use crate::library::MeetingDir;
use crate::pipeline::{emit_once, logged_keys, mic_speaker, passage_key, speaker_of, DRIFT_GAP};
use crate::reader::{TrackReader, PER_MS};
use crate::speakers::follower::{pad_with, FollowerTiming, Labeller};
use crate::speakers::turns::{passage_speaker, Turn};
use crate::transcript::{mic_number, LabelBatch, SplitWrite, Transcript};
use crate::watcher::{Stretch, TimelineWatcher};

/// The labeller's own ids for the voices it hears, before they get theirs.
const LABEL_PREFIX: &str = "voice-";

/// Why a split didn't finish.
#[derive(Debug)]
pub enum SplitError {
    /// Asked to stop, or the meeting went.
    Stopped,
    /// The timeline has no `stop` yet: the meeting still records.
    Recording,
    /// The microphone's audio isn't on this computer, or the meeting never recorded any.
    NoAudio,
    /// The speaker worker failed.
    Worker(DiarError),
    /// The meeting folder, `transcript.db` or the event log failed.
    Store(String),
}

impl fmt::Display for SplitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SplitError::Stopped => f.write_str("The split was stopped."),
            SplitError::Recording => f.write_str("The meeting is still recording."),
            SplitError::NoAudio => {
                f.write_str("The microphone's audio of this meeting is no longer on this computer.")
            }
            SplitError::Worker(e) => write!(f, "The speaker worker failed: {}", e.message),
            SplitError::Store(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for SplitError {}

impl From<DiarError> for SplitError {
    fn from(e: DiarError) -> SplitError {
        SplitError::Worker(e)
    }
}

impl From<rusqlite::Error> for SplitError {
    fn from(e: rusqlite::Error) -> SplitError {
        SplitError::Store(format!("The transcript store failed: {e}"))
    }
}

impl From<io::Error> for SplitError {
    fn from(e: io::Error) -> SplitError {
        SplitError::Store(format!("The meeting folder can't be read: {e}"))
    }
}

impl From<LogError> for SplitError {
    fn from(e: LogError) -> SplitError {
        SplitError::Store(format!("The event log failed: {e}"))
    }
}

/// The voice of a microphone passage in a split meeting: the voice with a clear majority of its
/// time ([`passage_speaker`]), or the user, `mic`, when none has one or the user dictated it.
/// The split and every passage the pipeline writes afterwards follow this rule.
pub(crate) fn mic_voice(turns: &[Turn], start_ms: u64, end_ms: u64, dictation: bool) -> String {
    let user = || speaker_of(Track::Mic).id;
    if dictation {
        return user();
    }
    passage_speaker(turns, start_ms, end_ms).unwrap_or_else(user)
}

/// The voices a split left on the meeting's microphone, `mic` included, once it was split.
pub fn split_voices(dir: &MeetingDir) -> Result<Option<u64>, SplitError> {
    if !dir.path().is_dir() {
        return Err(SplitError::Stopped);
    }
    Ok(Transcript::open(dir.path())?.split_voices()?)
}

/// The end of the microphone audio on this computer, in meeting ms; 0 when there is none, as
/// after retention removed it.
pub fn microphone_end(dir: &MeetingDir) -> Result<u64, SplitError> {
    let mut watcher = TimelineWatcher::new(dir.path());
    watcher.poll()?;
    let reader = TrackReader::new(dir.path(), Track::Mic.as_str(), watcher.mapper().segments());
    Ok(reader.end().div_ceil(PER_MS))
}

/// Tells apart the voices at the meeting's microphone and stores and sends the result; returns
/// the voices left on the track. A meeting split already only gets the events it still owes.
///
/// `progress` hears how far the stream got: meeting ms of the microphone heard so far, and the
/// end of the track. `stop` ends the split at its next push, without writing anything.
pub fn split_microphone(
    dir: &MeetingDir,
    log: &EventLog,
    diarizer: &dyn Diarizer,
    timing: &FollowerTiming,
    stop: &AtomicBool,
    progress: &dyn Fn(u64, u64),
) -> Result<u64, SplitError> {
    if split_voices(dir)?.is_some() {
        return send_split(dir, log);
    }
    let mut watcher = TimelineWatcher::new(dir.path());
    watcher.poll()?;
    let mapper = watcher.mapper();
    if mapper.stop().is_none() {
        return Err(SplitError::Recording);
    }
    let reader = TrackReader::new(dir.path(), Track::Mic.as_str(), mapper.segments());
    if reader.end() == 0 {
        return Err(SplitError::NoAudio);
    }
    let stretches = mapper.stretches();
    let heard = listen(dir, &reader, diarizer, timing, stop, progress)?;
    let write = assign(&heard, &stretches);
    if stop.load(Ordering::SeqCst) || !dir.path().is_dir() {
        return Err(SplitError::Stopped);
    }
    let mut transcript = Transcript::open(dir.path())?;
    let turns = write.turns.clone();
    transcript.record_split(&write, |passage| {
        (passage.track == Track::Mic)
            .then(|| mic_voice(&turns, passage.start, passage.end, passage.dictation))
    })?;
    send_split(dir, log)
}

/// Sends what a stored split owes Rukoo: a `speaker` for each other voice at the microphone that
/// has passages, then each of those passages at its revision, all that the log lacks. Returns the
/// voices on the track. Run after the split and again whenever a split meeting is asked about,
/// so a Voice that quit between the two still sends everything before it answers `done`.
pub fn send_split(dir: &MeetingDir, log: &EventLog) -> Result<u64, SplitError> {
    if !dir.path().is_dir() {
        return Err(SplitError::Stopped);
    }
    let transcript = Transcript::open(dir.path())?;
    let Some(voices) = transcript.split_voices()? else {
        return Err(SplitError::Store(
            "The microphone of this meeting wasn't split.".into(),
        ));
    };
    let meeting = dir.id().as_str();
    let Some(keys) = logged_keys(log, meeting)? else {
        return Err(SplitError::Stopped);
    };
    let mut emitted: HashSet<String> = keys.into_keys().collect();
    let others: Vec<Passage> = transcript
        .passages()?
        .into_iter()
        .map(|stored| stored.passage)
        .filter(|p| p.track == Track::Mic && p.speaker.as_deref().and_then(mic_number).is_some())
        .collect();
    let ids: BTreeMap<u64, String> = others
        .iter()
        .filter_map(|p| {
            let id = p.speaker.clone()?;
            Some((mic_number(&id)?, id))
        })
        .collect();
    for id in ids.values() {
        let key = format!("speaker:{id}");
        if emitted.contains(&key) {
            continue;
        }
        let speaker = mic_speaker(id);
        transcript.save_speaker(&speaker)?;
        emit_once::<SplitError>(
            log,
            &transcript,
            &mut emitted,
            meeting,
            key,
            events::SPEAKER,
            to_data(&speaker),
        )?;
    }
    for passage in &others {
        emit_once::<SplitError>(
            log,
            &transcript,
            &mut emitted,
            meeting,
            passage_key(&passage.id, passage.revision),
            events::PASSAGE,
            to_data(passage),
        )?;
    }
    Ok(voices)
}

fn to_data(value: &impl serde::Serialize) -> serde_json::Value {
    serde_json::to_value(value).expect("protocol types serialize")
}

/// What the stream heard: each turn under the labeller's id, and the stream's label for each id.
#[derive(Debug, Default, PartialEq)]
struct Heard {
    turns: Vec<Turn>,
    labels: HashMap<String, String>,
}

impl Heard {
    /// Takes in one step of the labeller. An open turn waits for the row that ends it.
    fn take(&mut self, batch: LabelBatch, open: &mut HashSet<(String, u64)>) {
        for row in batch.map {
            self.labels.insert(row.speaker, row.label);
        }
        for row in batch.turns {
            let key = (row.speaker.clone(), row.start);
            match row.end {
                None => {
                    open.insert(key);
                }
                Some(end) => {
                    open.remove(&key);
                    self.turns.push(Turn {
                        speaker: row.speaker,
                        start: row.start,
                        end,
                    });
                }
            }
        }
    }
}

/// Feeds the whole recorded track to one diarizer stream, as fast as it takes it.
fn listen(
    dir: &MeetingDir,
    reader: &TrackReader,
    diarizer: &dyn Diarizer,
    timing: &FollowerTiming,
    stop: &AtomicBool,
    progress: &dyn Fn(u64, u64),
) -> Result<Heard, SplitError> {
    let stopped = || stop.load(Ordering::SeqCst) || !dir.path().is_dir();
    let end_ms = reader.end().div_ceil(PER_MS);
    let mut stream = diarizer.open()?;
    let mut labeller = Labeller::fresh(LABEL_PREFIX, stream.geometry());
    let mut heard = Heard::default();
    let mut open = HashSet::new();
    let push_max = timing.push_max.max(1);
    let mut push = |stream: &mut dyn DiarStream,
                    labeller: &mut Labeller,
                    pcm: &[i16]|
     -> Result<(), SplitError> {
        if stopped() {
            return Err(SplitError::Stopped);
        }
        let probs = stream.push(pcm)?;
        heard.take(labeller.take(probs)?, &mut open);
        Ok(())
    };
    progress(0, end_ms);
    let mut fed = 0;
    loop {
        if reader.covered(fed) {
            let span_end = reader.span_end(fed, 0).unwrap_or(fed);
            let len = (span_end - fed).min(push_max);
            let pcm = reader.read(fed, fed + len)?;
            labeller.clock.append(fed, len);
            push(stream.as_mut(), &mut labeller, &pcm)?;
            fed += len;
            progress(fed / PER_MS, end_ms);
            continue;
        }
        match reader.next_audio(fed) {
            Some(next) => {
                // A gap, as the follower pads one, so the stream commits the audio before it.
                if next - fed >= DRIFT_GAP && labeller.clock.last_is_real() {
                    pad_with(&mut labeller, timing.pad, push_max, |labeller, zeros| {
                        push(stream.as_mut(), labeller, zeros)
                    })?;
                }
                fed = next;
            }
            None => break,
        }
    }
    // The end of the track, padded as the follower pads the end of what was recorded.
    if labeller.clock.last_is_real() {
        pad_with(&mut labeller, timing.pad, push_max, |labeller, zeros| {
            push(stream.as_mut(), labeller, zeros)
        })?;
    }
    if stopped() {
        return Err(SplitError::Stopped);
    }
    let probs = stream.finish()?;
    let mut batch = labeller.take(probs)?;
    labeller.close(&mut batch);
    heard.take(batch, &mut open);
    // The labeller closes every turn; one it somehow didn't ends with the track.
    for (speaker, start) in open {
        heard.turns.push(Turn {
            speaker,
            start,
            end: end_ms.max(start),
        });
    }
    heard.turns.sort_by(|a, b| {
        a.start
            .cmp(&b.start)
            .then_with(|| a.speaker.cmp(&b.speaker))
    });
    progress(end_ms, end_ms);
    Ok(heard)
}

/// One voice the stream heard, under the labeller's id.
struct Voice {
    id: String,
    first: u64,
    total: u64,
    dictating: u64,
}

/// Gives each voice its id: the user's is `mic`, the others `mic-2` on in the order of their
/// first turn.
fn assign(heard: &Heard, stretches: &[Stretch]) -> SplitWrite {
    let mut voices: Vec<Voice> = Vec::new();
    for turn in &heard.turns {
        let length = turn.end.saturating_sub(turn.start);
        let dictating: u64 = stretches
            .iter()
            .map(|s| {
                let until = s.end.unwrap_or(u64::MAX).min(turn.end);
                until.saturating_sub(s.start.max(turn.start))
            })
            .sum();
        match voices.iter_mut().find(|v| v.id == turn.speaker) {
            Some(voice) => {
                voice.first = voice.first.min(turn.start);
                voice.total += length;
                voice.dictating += dictating;
            }
            None => voices.push(Voice {
                id: turn.speaker.clone(),
                first: turn.start,
                total: length,
                dictating,
            }),
        }
    }
    voices.sort_by(|a, b| a.first.cmp(&b.first).then_with(|| a.id.cmp(&b.id)));
    // The most of `time`; a tie goes to the voice heard first.
    let most = |time: fn(&Voice) -> u64| {
        voices
            .iter()
            .filter(|v| time(v) > 0)
            .max_by(|a, b| time(a).cmp(&time(b)).then(b.first.cmp(&a.first)))
            .map(|v| v.id.clone())
    };
    let user = most(|v| v.dictating).or_else(|| most(|v| v.total));
    let mut ids: HashMap<&str, String> = HashMap::new();
    let mut next = 2;
    for voice in &voices {
        let id = if user.as_deref() == Some(voice.id.as_str()) {
            speaker_of(Track::Mic).id
        } else {
            let id = format!("mic-{next}");
            next += 1;
            id
        };
        ids.insert(voice.id.as_str(), id);
    }
    let mut map: Vec<(String, String)> = voices
        .iter()
        .map(|v| {
            let label = heard
                .labels
                .get(&v.id)
                .cloned()
                .unwrap_or_else(|| v.id.clone());
            (label, ids[v.id.as_str()].clone())
        })
        .collect();
    map.sort();
    SplitWrite {
        map,
        turns: heard
            .turns
            .iter()
            .map(|t| Turn {
                speaker: ids[t.speaker.as_str()].clone(),
                start: t.start,
                end: t.end,
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(speaker: &str, start: u64, end: u64) -> Turn {
        Turn {
            speaker: speaker.into(),
            start,
            end,
        }
    }

    fn heard(turns: Vec<Turn>) -> Heard {
        let labels = turns
            .iter()
            .map(|t| {
                (
                    t.speaker.clone(),
                    t.speaker.trim_start_matches(LABEL_PREFIX).into(),
                )
            })
            .collect();
        Heard { turns, labels }
    }

    fn ids(write: &SplitWrite) -> Vec<(String, String)> {
        write.map.clone()
    }

    #[test]
    fn the_voice_heard_longest_is_the_user_and_the_rest_count_from_two_by_first_turn() {
        let write = assign(
            &heard(vec![
                turn("voice-1", 0, 1_000),
                turn("voice-2", 1_000, 9_000),
                turn("voice-3", 9_000, 10_000),
                turn("voice-1", 10_000, 11_000),
            ]),
            &[],
        );
        assert_eq!(
            ids(&write),
            [
                ("1".into(), "mic-2".into()),
                ("2".into(), "mic".into()),
                ("3".into(), "mic-3".into())
            ]
        );
        let speakers: Vec<&str> = write.turns.iter().map(|t| t.speaker.as_str()).collect();
        assert_eq!(speakers, ["mic-2", "mic", "mic-3", "mic-2"]);
    }

    #[test]
    fn the_voice_heard_most_while_the_user_dictated_is_the_user() {
        let turns = vec![
            turn("voice-1", 0, 8_000),
            turn("voice-2", 8_000, 10_000),
            turn("voice-2", 20_000, 21_000),
        ];
        let dictation = [Stretch {
            start: 19_500,
            end: Some(22_000),
        }];
        let write = assign(&heard(turns.clone()), &dictation);
        assert_eq!(
            ids(&write),
            [("1".into(), "mic-2".into()), ("2".into(), "mic".into())]
        );
        // Dictation that nobody spoke in leaves the rule to the longest voice.
        let silent = [Stretch {
            start: 30_000,
            end: Some(31_000),
        }];
        let write = assign(&heard(turns), &silent);
        assert_eq!(write.map[0], ("1".into(), "mic".into()));
    }

    #[test]
    fn a_tie_goes_to_the_voice_heard_first() {
        let write = assign(
            &heard(vec![
                turn("voice-2", 0, 1_000),
                turn("voice-1", 1_000, 2_000),
            ]),
            &[],
        );
        assert_eq!(
            ids(&write),
            [("1".into(), "mic-2".into()), ("2".into(), "mic".into())]
        );
    }

    #[test]
    fn nothing_heard_is_nobody() {
        let write = assign(&Heard::default(), &[]);
        assert!(write.map.is_empty() && write.turns.is_empty());
    }

    #[test]
    fn dictation_and_unclear_passages_stay_the_user_s() {
        let turns = vec![turn("mic", 0, 5_000), turn("mic-2", 5_000, 10_000)];
        assert_eq!(mic_voice(&turns, 5_500, 9_000, false), "mic-2");
        assert_eq!(mic_voice(&turns, 5_500, 9_000, true), "mic");
        assert_eq!(
            mic_voice(&turns, 2_500, 7_500, false),
            "mic",
            "half and half"
        );
        assert_eq!(mic_voice(&turns, 20_000, 21_000, false), "mic", "nobody");
    }
}
