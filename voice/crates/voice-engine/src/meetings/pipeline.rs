//! WAVE 2 ADAPTER for `voice_meetings::{Library, Pipeline}` (architecture.md, "Wave 2
//! interfaces"). Wave 3 replaces this file with the real crate; the names and shapes follow that
//! API so the swap is mechanical.
//!
//! What the adapter does: makes meeting folders and `meeting.json`, lists meetings, finds
//! interrupted ones, and follows a meeting's timeline to emit the events Rukoo needs to see a
//! meeting start, pause, carry marks and stop: `meeting.started`, `speaker`, `meeting.state`
//! and `mark`. What it doesn't do: transcribe. Without `voice_meetings::Pipeline` no passages
//! are emitted and a stopped meeting stays `processing`; `meeting.get` answers `not_available`.

use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};
use voice_bridge::{EventLog, Stored};
use voice_protocol::{events, MeetingId, MeetingState, MeetingSummary, StartedBy, Track};
use voice_recorder::meeting::timeline_path;
use voice_recorder::timeline::{self, Line};

/// How often a follower reads the timeline.
const FOLLOW_INTERVAL: Duration = Duration::from_millis(500);

/// What a new meeting records, for `meeting.json`.
#[derive(Clone, Debug)]
pub struct CreateMeeting {
    pub title: String,
    pub tracks: Vec<Track>,
    /// Track name to recorder source, such as `mic` to `default-input`.
    pub sources: Vec<(String, String)>,
    pub screen: String,
    pub started_by: StartedBy,
    pub context: Option<Map<String, Value>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MeetingDir {
    pub id: String,
    pub path: PathBuf,
}

/// `<data>/meetings`.
#[derive(Clone, Debug)]
pub struct Library {
    root: PathBuf,
}

impl Library {
    pub fn open(data_dir: &Path) -> io::Result<Library> {
        let root = voice_core::paths::meetings_dir(data_dir);
        fs::create_dir_all(&root)?;
        Ok(Library { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Makes the folder and `meeting.json` (written to a temporary name, then renamed) for a new
    /// meeting with a fresh id.
    pub fn create(&self, args: &CreateMeeting) -> io::Result<MeetingDir> {
        for _ in 0..16 {
            let id = MeetingId::new(SystemTime::now()).into_string();
            let path = self.root.join(&id);
            match fs::create_dir(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e),
            }
            let sources: Map<String, Value> = args
                .sources
                .iter()
                .map(|(track, source)| (track.clone(), Value::String(source.clone())))
                .collect();
            let meeting = json!({
                "id": id,
                "title": args.title,
                "createdAt": now_ms(),
                "tracks": args.tracks.iter().map(|t| t.as_str()).collect::<Vec<_>>(),
                "sources": sources,
                "screen": args.screen,
                "startedBy": args.started_by.as_str(),
                "context": args.context.clone().map_or(Value::Null, Value::Object),
                "version": 1,
            });
            let tmp = path.join("meeting.json.tmp");
            {
                let mut file = fs::File::create(&tmp)?;
                io::Write::write_all(&mut file, &serde_json::to_vec_pretty(&meeting)?)?;
                file.sync_all()?;
            }
            fs::rename(&tmp, path.join("meeting.json"))?;
            return Ok(MeetingDir { id, path });
        }
        Err(io::Error::other("couldn't find an unused meeting id"))
    }

    pub fn dir(&self, id: &str) -> Option<MeetingDir> {
        if !voice_protocol::is_meeting_id(id) {
            return None;
        }
        let path = self.root.join(id);
        path.join("meeting.json").is_file().then(|| MeetingDir {
            id: id.to_string(),
            path,
        })
    }

    /// Every meeting folder, oldest first.
    pub fn all(&self) -> Vec<MeetingDir> {
        let mut ids: Vec<String> = fs::read_dir(&self.root)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| voice_protocol::is_meeting_id(name))
            .collect();
        ids.sort();
        ids.into_iter().filter_map(|id| self.dir(&id)).collect()
    }

    /// The newest meetings first, PROTOCOL.md `meeting.list` shape. The adapter can't tell
    /// `processing` from `done`, because it doesn't transcribe.
    pub fn list(&self, limit: usize) -> Vec<MeetingSummary> {
        let mut all = self.all();
        all.reverse();
        all.into_iter()
            .take(limit)
            .filter_map(|dir| summary(&dir))
            .collect()
    }

    /// Meetings whose timeline has no `stop` and whose recorder doesn't answer.
    pub fn interrupted(&self) -> Vec<String> {
        self.all()
            .into_iter()
            .filter(|dir| {
                let Ok(lines) = timeline::read(&timeline_path(&dir.path)) else {
                    return false;
                };
                !lines.is_empty()
                    && !lines.iter().any(|l| matches!(l, Line::Stop { .. }))
                    && voice_recorder::meeting::live_recorder(&dir.path).is_none()
            })
            .map(|dir| dir.id)
            .collect()
    }

    pub fn usage_bytes(&self) -> u64 {
        folder_size(&self.root)
    }
}

fn folder_size(path: &Path) -> u64 {
    fs::read_dir(path)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| match entry.file_type() {
            Ok(kind) if kind.is_dir() => folder_size(&entry.path()),
            Ok(_) => entry.metadata().map_or(0, |m| m.len()),
            Err(_) => 0,
        })
        .sum()
}

fn read_meeting(dir: &Path) -> Option<Value> {
    let bytes = fs::read(dir.join("meeting.json")).ok()?;
    serde_json::from_slice::<Value>(&bytes)
        .ok()
        .filter(Value::is_object)
}

fn summary(dir: &MeetingDir) -> Option<MeetingSummary> {
    let meeting = read_meeting(&dir.path)?;
    let lines = timeline::read(&timeline_path(&dir.path)).unwrap_or_default();
    let started_at = started_at(&meeting, &lines);
    let mut state = MeetingState::Recording;
    let mut ended_at = None;
    let mut duration = 0;
    for line in &lines {
        duration = duration.max(line.t().unwrap_or(0));
        match line {
            Line::Pause { .. } => state = MeetingState::Paused,
            Line::Resume { .. } => state = MeetingState::Recording,
            Line::Stop { t, wall, .. } => {
                state = MeetingState::Processing;
                ended_at = Some(*wall);
                duration = *t;
            }
            _ => {}
        }
    }
    Some(MeetingSummary {
        id: MeetingId::parse(&dir.id)?,
        title: meeting["title"].as_str().unwrap_or_default().to_string(),
        started_at,
        ended_at,
        state,
        duration,
    })
}

fn started_at(meeting: &Value, lines: &[Line]) -> u64 {
    lines
        .iter()
        .find_map(|line| match line {
            Line::Session {
                wall, session: 1, ..
            } => Some(*wall),
            _ => None,
        })
        .or_else(|| meeting["createdAt"].as_u64())
        .unwrap_or(0)
}

/// What `voice_meetings::Pipeline` takes; the adapter only keeps the consent gate, which wave 3
/// uses before it sends any audio to a provider.
#[derive(Clone)]
pub struct PipelineOptions {
    /// Decision 10: `Err(reason)` keeps recording and makes transcription wait.
    pub transcription_allowed: Arc<dyn Fn() -> Result<(), String> + Send + Sync>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PipelineState {
    Following,
    /// The timeline has `stop`; every event the adapter can derive was emitted.
    Finished,
}

pub struct Pipeline;

pub struct PipelineHandle {
    id: String,
    stop: Arc<AtomicBool>,
    finished: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Pipeline {
    /// Follows one meeting folder until its timeline has `stop`, emitting what it derives.
    /// Restart-safe: events already in the log aren't emitted again.
    pub fn start(dir: MeetingDir, log: EventLog, _opts: PipelineOptions) -> PipelineHandle {
        let stop = Arc::new(AtomicBool::new(false));
        let finished = Arc::new(AtomicBool::new(false));
        let id = dir.id.clone();
        let thread = thread::Builder::new()
            .name("meeting-follower".into())
            .spawn({
                let (stop, finished) = (Arc::clone(&stop), Arc::clone(&finished));
                move || {
                    let mut emitted = emitted_keys(&log, &dir.id);
                    while !stop.load(Ordering::SeqCst) {
                        if catch_up(&dir, &log, &mut emitted) {
                            finished.store(true, Ordering::SeqCst);
                            return;
                        }
                        thread::sleep(FOLLOW_INTERVAL);
                    }
                }
            })
            .ok();
        PipelineHandle {
            id,
            stop,
            finished,
            thread,
        }
    }
}

impl PipelineHandle {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn state(&self) -> PipelineState {
        if self.finished.load(Ordering::SeqCst) {
            PipelineState::Finished
        } else {
            PipelineState::Following
        }
    }

    /// Stops following (the app is quitting). Never touches the recorder.
    pub fn shutdown(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for PipelineHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

/// Emits what's missing for every stopped meeting, for example after the app was closed while a
/// recorder finished on its own. One pass over the log for all of them.
pub fn catch_up_stopped(lib: &Library, log: &EventLog) {
    let stored = log.after(0).unwrap_or_default();
    for dir in lib.all() {
        let mut emitted: HashSet<String> = stored
            .iter()
            .filter(|s| s.meeting.as_deref() == Some(dir.id.as_str()))
            .filter_map(key_of)
            .collect();
        let stopped = timeline::read(&timeline_path(&dir.path))
            .is_ok_and(|lines| lines.iter().any(|l| matches!(l, Line::Stop { .. })));
        if stopped {
            catch_up(&dir, log, &mut emitted);
        }
    }
}

fn emitted_keys(log: &EventLog, id: &str) -> HashSet<String> {
    log.after(0)
        .unwrap_or_default()
        .iter()
        .filter(|s| s.meeting.as_deref() == Some(id))
        .filter_map(key_of)
        .collect()
}

/// Emits the events not yet in the log. Returns whether the meeting has stopped.
fn catch_up(dir: &MeetingDir, log: &EventLog, emitted: &mut HashSet<String>) -> bool {
    let Some(meeting) = read_meeting(&dir.path) else {
        return false;
    };
    let lines = timeline::read(&timeline_path(&dir.path)).unwrap_or_default();
    let derived = derive(&meeting, &lines);
    for event in &derived.events {
        if emitted.contains(&event.key) {
            continue;
        }
        if log
            .append(&event.name, Some(&dir.id), event.data.clone())
            .is_ok()
        {
            emitted.insert(event.key.clone());
        }
    }
    derived.stopped
}

/// One event the adapter derives, with the key that says whether it was emitted already.
#[derive(Clone, Debug, PartialEq)]
pub struct Derived {
    pub key: String,
    pub name: String,
    pub data: Value,
}

#[derive(Debug, Default)]
pub struct Derivation {
    pub events: Vec<Derived>,
    pub stopped: bool,
}

/// The key of a stored event, matching [`derive`]'s keys.
fn key_of(stored: &Stored) -> Option<String> {
    let data = &stored.data;
    Some(match stored.event.as_str() {
        events::MEETING_STARTED => "started".to_string(),
        events::SPEAKER => format!("speaker:{}", data["id"].as_str()?),
        events::MEETING_STATE => {
            format!("state:{}:{}", data["state"].as_str()?, data["at"].as_u64()?)
        }
        events::MARK => format!("mark:{}", data["id"].as_str()?),
        _ => return None,
    })
}

fn event(key: String, name: &str, data: Value) -> Derived {
    Derived {
        key,
        name: name.to_string(),
        data,
    }
}

fn mark(
    id: String,
    kind: &str,
    at: u64,
    until: Option<u64>,
    track: Option<&str>,
    detail: Option<&str>,
    label: Option<&str>,
) -> Derived {
    event(
        format!("mark:{id}"),
        events::MARK,
        json!({
            "id": id,
            "kind": kind,
            "at": at,
            "until": until.map(|u| u.max(at)),
            "track": track,
            "detail": detail,
            "label": label,
        }),
    )
}

/// Every event a meeting folder implies, in order. Pure, so it is tested on made-up timelines.
pub fn derive(meeting: &Value, lines: &[Line]) -> Derivation {
    let mut out = Derivation::default();
    if !lines.iter().any(|l| matches!(l, Line::Session { .. })) {
        return out;
    }
    let tracks: Vec<String> = meeting["tracks"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .filter(|t| matches!(*t, "mic" | "call"))
                .map(str::to_string)
                .collect()
        })
        .filter(|list: &Vec<String>| !list.is_empty())
        .unwrap_or_else(|| vec!["mic".into(), "call".into()]);
    out.events.push(event(
        "started".into(),
        events::MEETING_STARTED,
        json!({
            "title": meeting["title"].as_str().unwrap_or_default(),
            "startedAt": started_at(meeting, lines),
            "tracks": tracks,
            "screen": "off",
            "startedBy": if meeting["startedBy"] == "rukoo" { "rukoo" } else { "voice" },
            "context": if meeting["context"].is_object() { meeting["context"].clone() } else { Value::Null },
        }),
    ));
    for track in &tracks {
        let (id, label) = if track == "mic" {
            ("mic", "You")
        } else {
            ("call-1", "Speaker 1")
        };
        out.events.push(event(
            format!("speaker:{id}"),
            events::SPEAKER,
            json!({"id": id, "track": track, "label": label}),
        ));
    }
    let state = |state: &str, at: u64| {
        event(
            format!("state:{state}:{at}"),
            events::MEETING_STATE,
            json!({"state": state, "at": at}),
        )
    };
    out.events.push(state("recording", 0));

    let mut gaps: Vec<(String, u64)> = Vec::new();
    let mut dictation: Option<u64> = None;
    for line in lines {
        match line {
            Line::Pause { t } => out.events.push(state("paused", *t)),
            Line::Resume { t } => out.events.push(state("recording", *t)),
            Line::Mark { t, id, label } => out.events.push(mark(
                id.clone(),
                "user",
                *t,
                None,
                None,
                None,
                label.as_deref(),
            )),
            Line::Dictation { t, state } if state == "start" => dictation = dictation.or(Some(*t)),
            Line::Dictation { t, state } if state == "end" => {
                if let Some(at) = dictation.take() {
                    out.events.push(mark(
                        format!("dict-{at}"),
                        "dictation",
                        at,
                        Some(*t),
                        Some("mic"),
                        None,
                        None,
                    ));
                }
            }
            Line::DeviceLost { t, track, .. } => {
                if !gaps.iter().any(|(open, _)| open == track) {
                    gaps.push((track.clone(), *t));
                }
            }
            Line::Device {
                t,
                track,
                device,
                reason,
            } => {
                if let Some(index) = gaps.iter().position(|(open, _)| open == track) {
                    let (_, at) = gaps.remove(index);
                    out.events.push(mark(
                        format!("gap-{track}-{at}"),
                        "gap",
                        at,
                        Some(*t),
                        Some(track),
                        Some("device"),
                        None,
                    ));
                } else if reason == "default" {
                    out.events.push(mark(
                        format!("dev-{track}-{t}"),
                        "device",
                        *t,
                        None,
                        Some(track),
                        Some("default"),
                        Some(device),
                    ));
                }
            }
            Line::Crash { t, last_seen } => {
                out.events.push(mark(
                    format!("gap-crash-{last_seen}"),
                    "gap",
                    *last_seen,
                    Some(*t),
                    None,
                    Some("crash"),
                    None,
                ));
            }
            Line::Suspend { t, until } => {
                out.events.push(mark(
                    format!("gap-suspend-{t}"),
                    "gap",
                    *t,
                    Some(*until),
                    None,
                    Some("suspend"),
                    None,
                ));
            }
            Line::Stop { t, wall, reason } => {
                for (track, at) in gaps.drain(..) {
                    out.events.push(mark(
                        format!("gap-{track}-{at}"),
                        "gap",
                        at,
                        Some(*t),
                        Some(&track),
                        Some("device"),
                        None,
                    ));
                }
                if let Some(at) = dictation.take() {
                    out.events.push(mark(
                        format!("dict-{at}"),
                        "dictation",
                        at,
                        Some(*t),
                        Some("mic"),
                        None,
                        None,
                    ));
                }
                out.events.push(event(
                    format!("state:processing:{t}"),
                    events::MEETING_STATE,
                    json!({"state": "processing", "at": t, "endedAt": wall, "reason": reason}),
                ));
                out.stopped = true;
            }
            _ => {}
        }
    }
    out
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(text: &str) -> Vec<Line> {
        timeline::parse(text)
    }

    fn meeting() -> Value {
        json!({"id": "m-20261030-120000-abcd", "title": "Weekly", "createdAt": 5, "tracks": ["mic", "call"], "startedBy": "rukoo", "context": {"calendarEvent": "x"}})
    }

    #[test]
    fn a_meeting_derives_its_events_and_validates() {
        let timeline = concat!(
            r#"{"kind":"session","t":0,"wall":1000,"session":1,"pid":1,"resumed":false,"version":1}"#,
            "\n",
            r#"{"kind":"pause","t":2000}"#,
            "\n",
            r#"{"kind":"resume","t":3000}"#,
            "\n",
            r#"{"kind":"mark","t":3500,"id":"k-1","label":"Decision"}"#,
            "\n",
            r#"{"kind":"dictation","t":4000,"state":"start"}"#,
            "\n",
            r#"{"kind":"dictation","t":4800,"state":"end"}"#,
            "\n",
            r#"{"kind":"device_lost","t":5000,"track":"mic","error":"gone"}"#,
            "\n",
            r#"{"kind":"device","t":6000,"track":"mic","device":"USB","reason":"reconnected"}"#,
            "\n",
            r#"{"kind":"crash","t":9000,"lastSeen":7000}"#,
            "\n",
            r#"{"kind":"device_lost","t":9500,"track":"call","error":"gone"}"#,
            "\n",
            r#"{"kind":"stop","t":10000,"wall":11000,"reason":"user"}"#,
            "\n",
        );
        let derived = derive(&meeting(), &lines(timeline));
        assert!(derived.stopped);
        let keys: Vec<&str> = derived.events.iter().map(|e| e.key.as_str()).collect();
        assert_eq!(
            keys,
            [
                "started",
                "speaker:mic",
                "speaker:call-1",
                "state:recording:0",
                "state:paused:2000",
                "state:recording:3000",
                "mark:k-1",
                "mark:dict-4000",
                "mark:gap-mic-5000",
                "mark:gap-crash-7000",
                "mark:gap-call-9500",
                "state:processing:10000",
            ]
        );
        assert_eq!(derived.events[0].data["startedAt"], 1000);
        assert_eq!(derived.events[0].data["startedBy"], "rukoo");
        assert_eq!(derived.events[11].data["endedAt"], 11000);
        // Every event passes the checks Rukoo applies.
        for event in &derived.events {
            let message = json!({
                "type": "event", "seq": 1, "event": event.name,
                "meeting": "m-20261030-120000-abcd", "createdAt": 1, "data": event.data,
            });
            voice_protocol::validate_incoming(voice_protocol::Side::Voice, &message)
                .unwrap_or_else(|e| panic!("{}: {}", event.key, e.reason));
        }
    }

    #[test]
    fn nothing_before_the_recorder_started() {
        assert!(derive(&meeting(), &[]).events.is_empty());
    }

    #[test]
    fn emitted_events_are_recognized_after_a_restart() {
        let data = std::env::temp_dir().join(format!(
            "voice-engine-adapter-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let log = EventLog::open(&data).unwrap();
        let lib = Library::open(&data).unwrap();
        let dir = lib
            .create(&CreateMeeting {
                title: "T".into(),
                tracks: vec![Track::Mic],
                sources: vec![("mic".into(), "default-input".into())],
                screen: "off".into(),
                started_by: StartedBy::Voice,
                context: None,
            })
            .unwrap();
        fs::write(
            timeline_path(&dir.path),
            concat!(
                r#"{"kind":"session","t":0,"wall":1000,"session":1,"pid":1,"resumed":false,"version":1}"#, "\n",
                r#"{"kind":"stop","t":500,"wall":1500,"reason":"user"}"#, "\n",
            ),
        )
        .unwrap();
        let mut emitted = emitted_keys(&log, &dir.id);
        assert!(catch_up(&dir, &log, &mut emitted));
        let head = log.head();
        assert_eq!(head, 4, "started, speaker, recording, processing");
        // A new follower finds them in the log and emits nothing twice.
        catch_up_stopped(&lib, &log);
        let mut again = emitted_keys(&log, &dir.id);
        assert!(catch_up(&dir, &log, &mut again));
        assert_eq!(log.head(), head);
        let list = lib.list(10);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].state, MeetingState::Processing);
        assert_eq!(
            (list[0].started_at, list[0].ended_at, list[0].duration),
            (1000, Some(1500), 500)
        );
        drop(log);
        let _ = fs::remove_dir_all(&data);
    }
}
