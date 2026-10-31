//! The meeting library: one folder per meeting in `<data>/meetings`, in the format of
//! voice/RECORDING.md.

use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use voice_bridge::EventLog;
use voice_core::config::Retention;
use voice_protocol::{
    events, MeetingId, MeetingState, MeetingStateChange, MeetingSummary, Object, ScreenMode,
    StartedBy, Track,
};
use voice_recorder::timeline::{self, Line};

use crate::transcript;
use crate::watcher::derive;

/// The library's folder in Voice's data folder.
pub const MEETINGS: &str = "meetings";
pub const MEETING_FILE: &str = "meeting.json";
/// The version of `meeting.json`, as in voice/RECORDING.md.
pub const FORMAT_VERSION: u32 = 1;
/// The `meeting.json` field with Settings > Meetings > Keep audio as it was when the meeting
/// started: `days7`, `keep` or `after_transcription`. See [`MeetingDir::retention`].
pub const RETENTION_FIELD: &str = "retention";

/// `meeting.json`: the app's description of a meeting, written once before the recorder starts.
///
/// The file also holds [`RETENTION_FIELD`] when the library had one to stamp; it is read on its
/// own, so a file without it, from before Voice stored it, reads the same.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingFile {
    pub id: MeetingId,
    #[serde(default)]
    pub title: String,
    /// Wall time the app made the meeting; the meeting's `startedAt`.
    pub created_at: u64,
    pub tracks: Vec<Track>,
    /// The recorder source of each track, such as `"mic": "default-input"`.
    #[serde(default)]
    pub sources: BTreeMap<String, String>,
    #[serde(default)]
    pub screen: ScreenMode,
    pub started_by: StartedBy,
    #[serde(default)]
    pub context: Option<Object>,
    #[serde(default = "format_version")]
    pub version: u32,
}

fn format_version() -> u32 {
    FORMAT_VERSION
}

impl MeetingFile {
    /// The data of the meeting's `meeting.started` event.
    pub fn started(&self) -> Value {
        json!({
            "title": self.title,
            "startedAt": self.created_at,
            "tracks": self.tracks,
            "screen": self.screen,
            "startedBy": self.started_by,
            "context": self.context,
        })
    }
}

/// What a new meeting records.
#[derive(Clone, Debug, PartialEq)]
pub struct CreateMeeting {
    pub title: String,
    pub tracks: Vec<Track>,
    /// The recorder source of each track, such as `"mic" => "default-input"`.
    pub sources: BTreeMap<String, String>,
    pub screen: ScreenMode,
    pub started_by: StartedBy,
    /// The object `meeting.start` passed, kept unchanged.
    pub context: Option<Object>,
}

/// One meeting's folder.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MeetingDir {
    id: MeetingId,
    path: PathBuf,
}

impl MeetingDir {
    /// The meeting in `path`, whose folder name is its id.
    pub fn at(path: &Path) -> Option<MeetingDir> {
        let id = MeetingId::parse(path.file_name()?.to_str()?)?;
        Some(MeetingDir {
            id,
            path: path.to_owned(),
        })
    }

    pub fn id(&self) -> &MeetingId {
        &self.id
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn meeting(&self) -> io::Result<MeetingFile> {
        let bytes = fs::read(self.path.join(MEETING_FILE))?;
        serde_json::from_slice(&bytes).map_err(io::Error::other)
    }

    /// The timeline's complete lines; an unreadable timeline reads as empty.
    pub fn timeline(&self) -> Vec<Line> {
        timeline::read(&self.path.join(timeline::FILE_NAME)).unwrap_or_default()
    }

    /// The folder that holds the recorded audio. Retention removes it; the text stays.
    pub fn audio_dir(&self) -> PathBuf {
        self.path.join("audio")
    }

    pub fn has_audio(&self) -> bool {
        self.audio_dir().is_dir()
    }

    /// How long this meeting's audio is kept, as chosen when it started (Ownkey kept it per
    /// meeting too, so changing the setting never removes older meetings' audio). `None` for a
    /// meeting from before Voice stored it, or an unreadable `meeting.json`.
    pub fn retention(&self) -> Option<Retention> {
        let bytes = fs::read(self.path.join(MEETING_FILE)).ok()?;
        let value: Value = serde_json::from_slice(&bytes).ok()?;
        serde_json::from_value(value.get(RETENTION_FIELD)?.clone()).ok()
    }

    /// Whether the timeline ends with `stop`. Reads only the end of the file.
    pub fn stopped(&self) -> bool {
        last_line(&self.path.join(timeline::FILE_NAME))
            .is_some_and(|line| matches!(line, Line::Stop { .. }))
    }
}

/// The meetings in `<data>/meetings`.
#[derive(Clone, Debug)]
pub struct Library {
    root: PathBuf,
    /// The retention new meetings get in `meeting.json`; clones share it.
    retention: Arc<Mutex<Option<Retention>>>,
}

impl Library {
    /// Opens the library of a data folder, creating `meetings/` when it's missing.
    pub fn open(data_dir: &Path) -> io::Result<Library> {
        let root = data_dir.join(MEETINGS);
        fs::create_dir_all(&root)?;
        Ok(Library {
            root,
            retention: Arc::default(),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The audio retention every meeting made from now on keeps: Settings > Meetings > Keep
    /// audio. The app sets it at start and whenever the setting changes.
    pub fn set_retention(&self, retention: Retention) {
        *self
            .retention
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(retention);
    }

    /// Makes the folder and `meeting.json` of a new meeting. The id is new: when the folder of
    /// one made in the same second exists, another suffix is tried.
    pub fn create(&self, args: &CreateMeeting) -> io::Result<MeetingDir> {
        let now = SystemTime::now();
        let created_at = now
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX));
        for _ in 0..64 {
            let id = MeetingId::new(now);
            let path = self.root.join(id.as_str());
            match fs::create_dir(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e),
            }
            let file = MeetingFile {
                id: id.clone(),
                title: args.title.clone(),
                created_at,
                tracks: args.tracks.clone(),
                sources: args.sources.clone(),
                screen: args.screen,
                started_by: args.started_by,
                context: args.context.clone(),
                version: FORMAT_VERSION,
            };
            let retention = *self
                .retention
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            let written = serde_json::to_value(&file)
                .map_err(io::Error::other)
                .and_then(|mut value| {
                    if let Some(retention) = retention {
                        value[RETENTION_FIELD] = json!(retention);
                    }
                    write_atomic(&path.join(MEETING_FILE), &value)
                });
            if let Err(e) = written {
                let _ = fs::remove_dir_all(&path);
                return Err(e);
            }
            return Ok(MeetingDir { id, path });
        }
        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "no free meeting id in this second",
        ))
    }

    pub fn dir(&self, id: &str) -> Option<MeetingDir> {
        let id = MeetingId::parse(id)?;
        let path = self.root.join(id.as_str());
        path.join(MEETING_FILE)
            .is_file()
            .then_some(MeetingDir { id, path })
    }

    /// Every meeting folder that has a `meeting.json`.
    pub fn dirs(&self) -> Vec<MeetingDir> {
        let Ok(entries) = fs::read_dir(&self.root) else {
            return Vec::new();
        };
        let mut dirs: Vec<MeetingDir> = entries
            .filter_map(Result::ok)
            .filter_map(|e| MeetingDir::at(&e.path()))
            .filter(|d| d.path.join(MEETING_FILE).is_file())
            .collect();
        dirs.sort_by(|a, b| a.id.cmp(&b.id));
        dirs
    }

    /// The newest meetings first, at most `limit`, in the shape of `meeting.list`.
    pub fn list(&self, limit: usize) -> Vec<MeetingSummary> {
        let mut all: Vec<MeetingSummary> = self.dirs().iter().filter_map(summary).collect();
        all.sort_by(|a, b| {
            b.started_at
                .cmp(&a.started_at)
                .then_with(|| b.id.cmp(&a.id))
        });
        all.truncate(limit);
        all
    }

    /// The snapshot `meeting.get` answers: `{ meeting, speakers, passages, marks, head }`.
    ///
    /// It is the current version of everything the event log holds for the meeting, up to the
    /// head it was read with, so the events after `head` apply on top of it.
    pub fn get(&self, id: &str, log: &EventLog) -> Option<Value> {
        let dir = self.dir(id)?;
        let file = dir.meeting().ok()?;
        let (head, stored) = log.meeting_events(id).ok()?;
        let mut snapshot = Snapshot::new(file.started());
        for event in &stored {
            if event.event == events::MEETING_REMOVED {
                return None;
            }
            snapshot.apply(&event.event, &event.data);
        }
        let state = match snapshot.state.take() {
            Some(state) => Known::from(state),
            None => recorded_state(&dir),
        };
        Some(snapshot.finish(id, state, head))
    }

    /// Meetings whose timeline has no `stop` and whose recorder doesn't answer: the app finalizes
    /// them at its start. A meeting being created right now counts too, so call this before
    /// starting one.
    pub fn interrupted(&self) -> Vec<String> {
        self.dirs()
            .into_iter()
            .filter(|d| !d.stopped())
            .filter(|d| voice_recorder::meeting::live_recorder(&d.path).is_none())
            .map(|d| d.id.into_string())
            .collect()
    }

    /// Bytes on disk in the library.
    pub fn usage_bytes(&self) -> u64 {
        folder_size(&self.root)
    }
}

/// A meeting's `meeting.list` entry.
fn summary(dir: &MeetingDir) -> Option<MeetingSummary> {
    let file = dir.meeting().ok()?;
    let state = recorded_state(dir);
    Some(MeetingSummary {
        id: dir.id.clone(),
        title: file.title,
        started_at: file.created_at,
        ended_at: state.ended_at,
        state: state.state,
        duration: state.length,
    })
}

/// A meeting's state as far as it is known.
struct Known {
    state: MeetingState,
    /// The meeting time of the change, when it is known.
    at: Option<u64>,
    ended_at: Option<u64>,
    reason: Option<String>,
    /// The meeting's length so far.
    length: u64,
}

impl From<MeetingStateChange> for Known {
    fn from(change: MeetingStateChange) -> Known {
        Known {
            state: change.state,
            at: Some(change.at),
            ended_at: change.ended_at,
            reason: change.reason,
            length: change.at,
        }
    }
}

/// The meeting's state from what the pipeline stored, or else from the timeline.
fn recorded_state(dir: &MeetingDir) -> Known {
    if let Some(outcome) = transcript::stored_outcome(&dir.path) {
        return Known {
            state: outcome.state,
            at: Some(outcome.at),
            ended_at: Some(outcome.ended_at),
            reason: outcome.reason,
            length: outcome.at,
        };
    }
    let (mapper, _) = derive(&dir.timeline());
    match mapper.stop() {
        Some(stop) => Known {
            state: MeetingState::Processing,
            at: Some(stop.t),
            ended_at: Some(stop.wall),
            reason: Some(stop.reason.clone()),
            length: stop.t,
        },
        None => Known {
            state: mapper.state().unwrap_or(MeetingState::Recording),
            at: None,
            ended_at: None,
            reason: None,
            length: mapper.latest_t(),
        },
    }
}

/// The meeting as its events describe it, the newest version of each thing.
struct Snapshot {
    meeting: Value,
    state: Option<MeetingStateChange>,
    speakers: Vec<(String, Value)>,
    passages: HashMap<String, Value>,
    marks: HashMap<String, Value>,
}

impl Snapshot {
    fn new(started: Value) -> Snapshot {
        Snapshot {
            meeting: started,
            state: None,
            speakers: Vec::new(),
            passages: HashMap::new(),
            marks: HashMap::new(),
        }
    }

    fn apply(&mut self, event: &str, data: &Value) {
        let id = || data["id"].as_str().map(str::to_owned);
        match event {
            events::MEETING_STARTED => self.meeting = data.clone(),
            events::MEETING_STATE => {
                if let Ok(state) = serde_json::from_value(data.clone()) {
                    self.state = Some(state);
                }
            }
            events::SPEAKER => {
                if let Some(id) = id() {
                    match self.speakers.iter_mut().find(|(known, _)| *known == id) {
                        Some(entry) => entry.1 = data.clone(),
                        None => self.speakers.push((id, data.clone())),
                    }
                }
            }
            events::PASSAGE => {
                if let Some(id) = id() {
                    let revision = |v: &Value| v["revision"].as_u64().unwrap_or(0);
                    let newer = self
                        .passages
                        .get(&id)
                        .is_none_or(|old| revision(data) >= revision(old));
                    if newer {
                        self.passages.insert(id, data.clone());
                    }
                }
            }
            events::PASSAGE_REMOVED => {
                if let Some(id) = id() {
                    self.passages.remove(&id);
                }
            }
            events::MARK => {
                if let Some(id) = id() {
                    self.marks.insert(id, data.clone());
                }
            }
            _ => {}
        }
    }

    fn finish(self, id: &str, state: Known, head: u64) -> Value {
        let mut meeting = match self.meeting {
            Value::Object(object) => object,
            _ => Map::new(),
        };
        meeting.insert("id".into(), id.into());
        meeting.insert("state".into(), state.state.as_str().into());
        if let Some(at) = state.at {
            meeting.insert("at".into(), at.into());
        }
        meeting.insert("endedAt".into(), json!(state.ended_at));
        if let Some(reason) = state.reason {
            meeting.insert("reason".into(), reason.into());
        }
        let mut passages: Vec<Value> = self.passages.into_values().collect();
        passages.sort_by(|a, b| {
            let key = |v: &Value| {
                (
                    v["start"].as_u64().unwrap_or(0),
                    v["track"].as_str().unwrap_or("").to_owned(),
                )
            };
            key(a).cmp(&key(b))
        });
        let mut marks: Vec<Value> = self.marks.into_values().collect();
        marks.sort_by(|a, b| {
            let key = |v: &Value| {
                (
                    v["at"].as_u64().unwrap_or(0),
                    v["id"].as_str().unwrap_or("").to_owned(),
                )
            };
            key(a).cmp(&key(b))
        });
        let speakers: Vec<Value> = self.speakers.into_iter().map(|(_, v)| v).collect();
        json!({
            "meeting": meeting,
            "speakers": speakers,
            "passages": passages,
            "marks": marks,
            "head": head,
        })
    }
}

/// Writes JSON to a temporary name and renames it into place, so a reader never sees half.
fn write_atomic(path: &Path, value: &impl Serialize) -> io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(value).map_err(io::Error::other)?;
    {
        let mut out = File::create(&tmp)?;
        out.write_all(&bytes)?;
        out.sync_data()?;
    }
    fs::rename(&tmp, path)
}

/// The last complete line of a timeline that parses. Nothing follows `stop`, so this tells
/// whether a recording ended without reading an hour of heartbeats.
fn last_line(path: &Path) -> Option<Line> {
    const TAIL: u64 = 64 * 1024;
    let mut file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let from = len.saturating_sub(TAIL);
    file.seek(SeekFrom::Start(from)).ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    let end = bytes.iter().rposition(|&b| b == b'\n')?;
    let complete = &bytes[..end];
    let mut lines = complete.split(|&b| b == b'\n').rev();
    // When the tail starts mid-line, its first piece doesn't parse and is passed over.
    lines.find_map(|raw| serde_json::from_slice::<Line>(raw).ok())
}

fn folder_size(path: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .map(|entry| match entry.file_type() {
            Ok(kind) if kind.is_dir() => folder_size(&entry.path()),
            Ok(_) => entry.metadata().map_or(0, |m| m.len()),
            Err(_) => 0,
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    fn args(title: &str) -> CreateMeeting {
        CreateMeeting {
            title: title.into(),
            tracks: vec![Track::Mic, Track::Call],
            sources: [
                ("mic".to_owned(), "default-input".to_owned()),
                ("call".to_owned(), "default-output".to_owned()),
            ]
            .into(),
            screen: ScreenMode::Off,
            started_by: StartedBy::Voice,
            context: None,
        }
    }

    #[test]
    fn creates_a_meeting_folder_with_its_meeting_json() {
        let tmp = TempDir::new("library-create");
        let lib = Library::open(tmp.path()).unwrap();
        let a = lib.create(&args("Weekly")).unwrap();
        let b = lib.create(&args("Weekly")).unwrap();
        assert_ne!(a.id(), b.id());
        assert_eq!(a.path(), lib.root().join(a.id().as_str()));
        let file = a.meeting().unwrap();
        assert_eq!(file.title, "Weekly");
        assert_eq!(file.version, 1);
        let raw: Value =
            serde_json::from_slice(&fs::read(a.path().join(MEETING_FILE)).unwrap()).unwrap();
        assert_eq!(raw["sources"]["mic"], "default-input");
        assert_eq!(raw["startedBy"], "voice");
        assert_eq!(raw["context"], Value::Null);
        assert!(lib.dir(a.id().as_str()).is_some());
        assert!(lib.dir("m-20200101-000000-0000").is_none());
        assert!(lib.dir("../etc").is_none());
        assert!(!a.path().join("meeting.json.tmp").exists());
    }

    fn timeline(dir: &MeetingDir, lines: &[Value]) {
        let mut text = String::new();
        for line in lines {
            text.push_str(&line.to_string());
            text.push('\n');
        }
        fs::write(dir.path().join(timeline::FILE_NAME), text).unwrap();
    }

    #[test]
    fn lists_the_newest_first_with_their_state() {
        let tmp = TempDir::new("library-list");
        let lib = Library::open(tmp.path()).unwrap();
        let old = lib.create(&args("Old")).unwrap();
        let mut file = old.meeting().unwrap();
        file.created_at -= 60_000;
        write_atomic(&old.path().join(MEETING_FILE), &file).unwrap();
        timeline(
            &old,
            &[
                json!({"kind":"session","t":0,"wall":1,"session":1,"pid":1,"resumed":false,"version":1}),
                json!({"kind":"stop","t":4200,"wall":4201,"reason":"user"}),
            ],
        );
        let new = lib.create(&args("New")).unwrap();
        timeline(
            &new,
            &[
                json!({"kind":"session","t":0,"wall":1,"session":1,"pid":1,"resumed":false,"version":1}),
                json!({"kind":"pause","t":900}),
                json!({"kind":"heartbeat","t":1000,"wall":2,"samples":{}}),
            ],
        );
        fs::create_dir(lib.root().join("not-a-meeting")).unwrap();

        let list = lib.list(10);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].title, "New");
        assert_eq!(
            (list[0].state, list[0].ended_at, list[0].duration),
            (MeetingState::Paused, None, 1000)
        );
        assert_eq!(
            (list[1].state, list[1].ended_at, list[1].duration),
            (MeetingState::Processing, Some(4201), 4200)
        );
        assert_eq!(lib.list(1).len(), 1);
        assert!(new.path().join(timeline::FILE_NAME).is_file());
        assert!(
            !old.path().join(transcript::FILE_NAME).exists(),
            "listing creates nothing"
        );

        // Without a stop and without a recorder, the newer meeting was cut off.
        assert_eq!(lib.interrupted(), vec![new.id().to_string()]);
        assert!(lib.usage_bytes() > 0);
    }

    #[test]
    fn the_snapshot_is_the_newest_version_of_each_event_up_to_the_head() {
        let tmp = TempDir::new("library-get");
        let lib = Library::open(tmp.path()).unwrap();
        let log = EventLog::open(tmp.path()).unwrap();
        let dir = lib.create(&args("Snap")).unwrap();
        let id = dir.id().as_str();
        let passage = |start: u64, revision: u64, text: &str| json!({"id": voice_protocol::passage_id("mic", start), "track":"mic","speaker":"mic","start":start,"end":start + 500,"text":text,"revision":revision,"dictation":false,"language":null});
        // Nothing in the log yet: the state comes from the (missing) timeline.
        let snap = lib.get(id, &log).unwrap();
        assert_eq!(snap["meeting"]["state"], "recording");
        assert_eq!(snap["meeting"]["endedAt"], Value::Null);
        assert_eq!(snap["meeting"]["title"], "Snap");
        assert_eq!(snap["head"], 0);

        log.append(
            "meeting.started",
            Some(id),
            dir.meeting().unwrap().started(),
        )
        .unwrap();
        log.append(
            "speaker",
            Some(id),
            json!({"id":"mic","track":"mic","label":"You"}),
        )
        .unwrap();
        log.append("passage", Some(id), passage(2000, 1, "second"))
            .unwrap();
        log.append("passage", Some(id), passage(1000, 1, "first"))
            .unwrap();
        log.append("passage", Some(id), passage(1000, 2, "first, better"))
            .unwrap();
        log.append("passage", Some(id), passage(3000, 1, "gone"))
            .unwrap();
        log.append(
            "passage.removed",
            Some(id),
            json!({"id": voice_protocol::passage_id("mic", 3000)}),
        )
        .unwrap();
        log.append("mark", Some(id), json!({"id":"k-1","kind":"user","at":1500,"until":null,"track":null,"detail":null,"label":"Here"})).unwrap();
        log.append(
            "meeting.state",
            Some(id),
            json!({"state":"processing","at":4000,"endedAt":99,"reason":"user"}),
        )
        .unwrap();
        log.append(
            "status",
            None,
            json!({"recording": null, "dictating": false}),
        )
        .unwrap();

        let snap = lib.get(id, &log).unwrap();
        assert_eq!(snap["head"], 10);
        assert_eq!(snap["meeting"]["state"], "processing");
        assert_eq!(snap["meeting"]["endedAt"], 99);
        assert_eq!(snap["meeting"]["reason"], "user");
        assert_eq!(snap["meeting"]["id"], id);
        let texts: Vec<&str> = snap["passages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["text"].as_str().unwrap())
            .collect();
        assert_eq!(texts, ["first, better", "second"]);
        assert_eq!(snap["speakers"].as_array().unwrap().len(), 1);
        assert_eq!(snap["marks"][0]["label"], "Here");

        // Every item passes the checks Rukoo applies to events.
        for (event, list) in [
            ("passage", "passages"),
            ("speaker", "speakers"),
            ("mark", "marks"),
        ] {
            for data in snap[list].as_array().unwrap() {
                let message = json!({"type":"event","seq":1,"event":event,"meeting":id,"createdAt":0,"data":data});
                voice_protocol::validate_incoming(voice_protocol::Side::Voice, &message).unwrap();
            }
        }
        let started = json!({"type":"event","seq":1,"event":"meeting.started","meeting":id,"createdAt":0,"data":snap["meeting"]});
        voice_protocol::validate_incoming(voice_protocol::Side::Voice, &started).unwrap();

        log.remove_meeting(id).unwrap();
        assert!(lib.get(id, &log).is_none(), "a removed meeting isn't found");
        assert!(lib.get("m-20200101-000000-0000", &log).is_none());
    }

    #[test]
    fn the_last_line_tells_whether_the_recording_stopped() {
        let tmp = TempDir::new("library-last-line");
        let path = tmp.path().join("t.jsonl");
        assert!(last_line(&path).is_none());
        let mut text = String::new();
        for t in 0..3000 {
            text.push_str(
                &json!({"kind":"heartbeat","t":t,"wall":t,"samples":{"mic": t}}).to_string(),
            );
            text.push('\n');
        }
        fs::write(&path, &text).unwrap();
        assert!(matches!(
            last_line(&path),
            Some(Line::Heartbeat { t: 2999, .. })
        ));
        text.push_str(
            "{\"kind\":\"stop\",\"t\":3000,\"wall\":1,\"reason\":\"user\"}\n{\"kind\":\"hea",
        );
        fs::write(&path, &text).unwrap();
        assert!(matches!(last_line(&path), Some(Line::Stop { t: 3000, .. })));
    }
}
