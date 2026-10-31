//! A meeting from end to end: the real `rukoo-voice-recorder` records a file and a synthetic tone
//! into a temp meeting, the pipeline transcribes it with a recognizer that needs no model, and a
//! WebSocket client playing Rukoo reads the events from the real bridge server.
//!
//! Passages must reach the client while the recorder still records, and `processing` and `done`
//! after it stops. A recorder that is killed and resumed in the middle leaves a gap mark and no
//! passage twice. The recorder binary is looked up next to this test's folder and built when it
//! isn't there.

mod common;

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use common::*;
use serde_json::{json, Value};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message as Frame, WebSocket};
use voice_bridge::{
    BridgeServer, ControlError, EventLog, MeetingControl, MeetingSummary, StartArgs, Status,
};
use voice_meetings::{CreateMeeting, Library, MeetingDir, Pipeline, PipelineOptions, Timing};
use voice_protocol::{validate_incoming, MeetingId, ScreenMode, Side, StartedBy, Track};
use voice_recorder::control::Client as RecorderClient;
use voice_recorder::meeting::read_recorder_file;

/// CI machines are slow and run several recorders at once.
const WAIT: Duration = Duration::from_secs(60);

/// The recorder binary of this build, built first when this test runs before it exists.
fn recorder_exe() -> &'static Path {
    static EXE: OnceLock<PathBuf> = OnceLock::new();
    EXE.get_or_init(|| {
        let name = format!("rukoo-voice-recorder{}", std::env::consts::EXE_SUFFIX);
        // target/<profile>/deps/live-<hash>[.exe]
        let deps = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .to_owned();
        let profile = deps.parent().unwrap().to_owned();
        let exe = profile.join(&name);
        if exe.is_file() {
            return exe;
        }
        let workspace = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
        let mut build = Command::new(cargo);
        build
            .current_dir(&workspace)
            .args([
                "build",
                "-p",
                "voice-recorder",
                "--bin",
                "rukoo-voice-recorder",
            ])
            .arg("--target-dir")
            .arg(profile.parent().unwrap());
        if profile.file_name().is_some_and(|n| n == "release") {
            build.arg("--release");
        }
        let status = build.status().expect("run cargo build for the recorder");
        assert!(status.success(), "building rukoo-voice-recorder failed");
        assert!(exe.is_file(), "no recorder at {}", exe.display());
        exe
    })
}

/// A 16 kHz mono WAV with the canonical header, for the recorder's `file:` source.
fn write_wav(path: &Path, pcm: &[i16]) {
    let mut bytes = voice_audio::segment_header(pcm.len() as u64).to_vec();
    for s in pcm {
        bytes.extend_from_slice(&s.to_le_bytes());
    }
    fs::write(path, bytes).unwrap();
}

/// Rukoo's side of the bridge in this test: answers `meeting.get` and `meeting.list` from the
/// library, and nothing else.
struct LibraryControl {
    library: Library,
    log: EventLog,
    recording: Mutex<Option<String>>,
}

impl MeetingControl for LibraryControl {
    fn start(&self, _args: StartArgs) -> Result<String, ControlError> {
        Err(ControlError::not_available("not in this test"))
    }
    fn stop(&self, _id: &str) -> Result<(), ControlError> {
        Err(ControlError::not_available("not in this test"))
    }
    fn pause(&self, _id: &str) -> Result<(), ControlError> {
        Err(ControlError::not_available("not in this test"))
    }
    fn resume(&self, _id: &str) -> Result<(), ControlError> {
        Err(ControlError::not_available("not in this test"))
    }
    fn mark(&self, _id: &str, _label: Option<&str>) -> Result<(String, u64), ControlError> {
        Err(ControlError::not_available("not in this test"))
    }
    fn list(&self, limit: usize) -> Vec<MeetingSummary> {
        self.library.list(limit)
    }
    fn get(&self, id: &str) -> Result<Value, ControlError> {
        self.library
            .get(id, &self.log)
            .ok_or_else(|| ControlError::not_found(format!("No meeting {id}.")))
    }
    fn frame(&self, _id: &str, _at: u64) -> Result<Value, ControlError> {
        Err(ControlError::not_available(
            "Voice 0.1 doesn't record the screen.",
        ))
    }
    fn status(&self) -> Status {
        Status {
            recording: self
                .recording
                .lock()
                .unwrap()
                .as_deref()
                .and_then(MeetingId::parse),
            dictating: false,
        }
    }
}

/// A client playing Rukoo: hello, welcome, then every message checked as Rukoo checks it.
struct Rukoo {
    socket: WebSocket<MaybeTlsStream<TcpStream>>,
    events: Vec<Value>,
}

impl Rukoo {
    fn connect(discovery: &Path) -> Rukoo {
        let file: Value = serde_json::from_slice(&fs::read(discovery).unwrap()).unwrap();
        let discovery = voice_protocol::validate_discovery(&file).unwrap();
        let (mut socket, _) =
            tungstenite::connect(format!("ws://127.0.0.1:{}/bridge", discovery.port)).unwrap();
        if let MaybeTlsStream::Plain(tcp) = socket.get_ref() {
            tcp.set_read_timeout(Some(Duration::from_millis(100)))
                .unwrap();
        }
        let hello = json!({"type":"hello","protocol":1,"token":discovery.token,"client":"rukoo","instance":null,"after":0});
        socket.send(Frame::text(hello.to_string())).unwrap();
        let mut rukoo = Rukoo {
            socket,
            events: Vec::new(),
        };
        let welcome = rukoo.next(WAIT).expect("a welcome");
        assert_eq!(welcome["type"], "welcome", "{welcome}");
        assert_eq!(welcome["replay"], "full");
        rukoo
    }

    /// The next message, or `None` when nothing came within `wait`.
    fn next(&mut self, wait: Duration) -> Option<Value> {
        let deadline = Instant::now() + wait;
        loop {
            match self.socket.read() {
                Ok(Frame::Text(text)) => {
                    let value: Value = serde_json::from_str(&text).unwrap();
                    if let Err(invalid) = validate_incoming(Side::Voice, &value) {
                        panic!("Voice sent a message Rukoo drops ({invalid}): {value}");
                    }
                    if value["type"] == "event" {
                        if let Some(last) = self.events.last() {
                            assert_eq!(
                                value["seq"].as_u64(),
                                last["seq"].as_u64().map(|s| s + 1),
                                "events arrive in order without gaps"
                            );
                        }
                        self.events.push(value.clone());
                    }
                    return Some(value);
                }
                Ok(_) => {}
                Err(tungstenite::Error::Io(e))
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) => {}
                Err(e) => panic!("the bridge connection failed: {e}"),
            }
            if Instant::now() >= deadline {
                return None;
            }
        }
    }

    /// Reads until `done` says the events so far are enough.
    fn read_until(&mut self, what: &str, mut done: impl FnMut(&[Value]) -> bool) {
        let deadline = Instant::now() + WAIT;
        while !done(&self.events) {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            self.next(Duration::from_millis(200));
        }
    }

    fn command(&mut self, id: &str, command: &str, args: Value) -> Value {
        let message = json!({"type":"command","id":id,"command":command,"args":args});
        self.socket.send(Frame::text(message.to_string())).unwrap();
        let deadline = Instant::now() + WAIT;
        loop {
            assert!(Instant::now() < deadline, "no reply to {command}");
            if let Some(reply) = self.next(Duration::from_millis(200)) {
                if reply["type"] == "reply" && reply["id"] == id {
                    return reply;
                }
            }
        }
    }
}

fn data_of<'a>(events: &'a [Value], name: &str) -> Vec<&'a Value> {
    events
        .iter()
        .filter(|e| e["event"] == name)
        .map(|e| &e["data"])
        .collect()
}

fn position(events: &[Value], check: impl Fn(&Value) -> bool) -> Option<usize> {
    events.iter().position(check)
}

fn is_state(event: &Value, state: &str) -> bool {
    event["event"] == "meeting.state" && event["data"]["state"] == state
}

/// One meeting: its folder, the recorder, the pipeline and the bridge.
struct Meeting {
    _tmp: TempDir,
    dir: MeetingDir,
    log: EventLog,
    sources: Vec<String>,
    logs: PathBuf,
    _bridge: voice_bridge::Handle,
    discovery: PathBuf,
}

impl Meeting {
    fn new(name: &str) -> Meeting {
        let tmp = TempDir::new(name);
        let data = tmp.path().join("data");
        let library = Library::open(&data).unwrap();
        let log = EventLog::open(&data).unwrap();
        // Speech-like bursts: 1.2 s of sound, 1.3 s of silence, over and over.
        let wav = tmp.path().join("speech.wav");
        write_wav(&wav, &speech(&[(1.2, true), (1.3, false)]));
        let sources = vec![
            format!("mic=file:{},loop", wav.display()),
            "call=synthetic:tone:660".to_owned(),
        ];
        let dir = library
            .create(&CreateMeeting {
                title: "End to end".into(),
                tracks: vec![Track::Mic, Track::Call],
                sources: BTreeMap::from([
                    ("mic".to_owned(), sources[0][4..].to_owned()),
                    ("call".to_owned(), sources[1][5..].to_owned()),
                ]),
                screen: ScreenMode::Off,
                started_by: StartedBy::Voice,
                context: None,
            })
            .unwrap();
        let control = Arc::new(LibraryControl {
            library,
            log: log.clone(),
            recording: Mutex::new(Some(dir.id().to_string())),
        });
        let discovery = tmp.path().join("bridge.json");
        let bridge = BridgeServer::start(log.clone(), control, &discovery, "0.1.0").unwrap();
        let logs = tmp.path().join("logs");
        fs::create_dir_all(&logs).unwrap();
        Meeting {
            dir,
            log,
            sources,
            logs,
            _bridge: bridge,
            discovery,
            _tmp: tmp,
        }
    }

    fn record(&self, resume: bool) -> Child {
        let n = fs::read_dir(&self.logs).unwrap().count();
        let stderr = fs::File::create(self.logs.join(format!("recorder-{n}.log"))).unwrap();
        let mut command = Command::new(recorder_exe());
        command
            .arg("record")
            .arg("--meeting")
            .arg(self.dir.path())
            .args(["--segment-ms", "2000"]);
        for source in &self.sources {
            command.args(["--track", source]);
        }
        if resume {
            command.arg("--resume");
        }
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(stderr)
            .spawn()
            .expect("start rukoo-voice-recorder")
    }

    fn pipeline(&self) -> voice_meetings::PipelineHandle {
        let options = PipelineOptions {
            timing: Timing {
                poll: Duration::from_millis(50),
                ..Timing::default()
            },
            ..PipelineOptions::new(Arc::new(Echo::default()))
        };
        Pipeline::start(self.dir.clone(), self.log.clone(), options)
    }

    /// Stops the recorder over its control port, as the app does.
    fn stop(&self, child: &mut Child) {
        let file = wait_until("recorder.json", WAIT, || {
            read_recorder_file(self.dir.path()).filter(|f| f.pid == child.id())
        });
        let mut client = RecorderClient::connect(file.port, Duration::from_secs(5)).unwrap();
        let reply = client
            .request(&json!({"token": file.token, "cmd": "stop"}))
            .unwrap();
        assert_eq!(reply["ok"], true, "{reply}");
        wait_until("the recorder to exit", WAIT, || child.try_wait().unwrap());
    }

    fn timeline(&self) -> Vec<Value> {
        fs::read_to_string(self.dir.path().join("timeline.jsonl"))
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect()
    }

    /// Waits until the timeline has a heartbeat at or after `t`.
    fn wait_for_heartbeat(&self, t: u64) {
        wait_until("a heartbeat", WAIT, || {
            self.timeline()
                .iter()
                .any(|l| l["kind"] == "heartbeat" && l["t"].as_u64() >= Some(t))
                .then_some(())
        });
    }
}

/// Kills a recorder that is still running when a test fails, so it doesn't outlive the test.
struct Running(Option<Child>);

impl Drop for Running {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take() {
            if child.try_wait().ok().flatten().is_none() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

#[test]
fn passages_reach_rukoo_while_the_meeting_records() {
    recorder_exe();
    let m = Meeting::new("live");
    let mut rukoo = Rukoo::connect(&m.discovery);
    let mut recorder = Running(Some(m.record(false)));
    let pipeline = m.pipeline();

    rukoo.read_until("two passages while recording", |events| {
        data_of(events, "passage").len() >= 2
    });
    let child = recorder.0.as_mut().unwrap();
    assert!(
        child.try_wait().unwrap().is_none(),
        "the recorder still records"
    );
    assert!(
        position(&rukoo.events, |e| is_state(e, "processing")).is_none(),
        "no processing before the stop"
    );
    let early = data_of(&rukoo.events, "passage").len();

    m.stop(child);
    rukoo.read_until("done", |events| {
        position(events, |e| is_state(e, "done")).is_some()
    });
    pipeline.shutdown();

    let events = &rukoo.events.clone();
    assert_eq!(events[0]["event"], "meeting.started");
    assert_eq!(events[0]["data"]["title"], "End to end");
    let processing = position(events, |e| is_state(e, "processing")).unwrap();
    let done = position(events, |e| is_state(e, "done")).unwrap();
    let first_passage = position(events, |e| e["event"] == "passage").unwrap();
    assert!(first_passage < processing && processing < done);
    assert_eq!(done, events.len() - 1, "done comes last");
    assert_eq!(events[processing]["data"]["reason"], "user");

    let passages = data_of(events, "passage");
    assert!(passages.len() >= early);
    let mic: Vec<&&Value> = passages.iter().filter(|p| p["track"] == "mic").collect();
    // Each mic passage covers one burst and the pause after it: about 2.5 s.
    for p in &mic[..early.min(mic.len())] {
        let length = p["end"].as_u64().unwrap() - p["start"].as_u64().unwrap();
        assert!((1500..=3500).contains(&length), "{p}");
        assert_eq!(p["speaker"], "mic");
    }
    // The call's tone never pauses, so its passage comes from the end of the recording.
    let call: Vec<&&Value> = passages.iter().filter(|p| p["track"] == "call").collect();
    assert!(
        !call.is_empty(),
        "the call track was transcribed at the stop"
    );
    assert_eq!(call[0]["speaker"], "call-1");
    let call_at = position(events, |e| {
        e["event"] == "passage" && e["data"]["track"] == "call"
    });
    assert!(call_at.unwrap() > processing);
    let ids: HashSet<&str> = passages.iter().map(|p| p["id"].as_str().unwrap()).collect();
    assert_eq!(ids.len(), passages.len(), "every passage once");

    // meeting.get holds the same passages, complete up to the last event.
    let reply = rukoo.command(
        "c-1",
        "meeting.get",
        json!({"meeting": m.dir.id().as_str()}),
    );
    assert_eq!(reply["ok"], true, "{reply}");
    let snapshot = &reply["result"];
    assert_eq!(snapshot["head"], events.last().unwrap()["seq"]);
    assert_eq!(snapshot["meeting"]["state"], "done");
    assert_eq!(
        snapshot["passages"].as_array().unwrap().len(),
        passages.len()
    );
    let reply = rukoo.command("c-2", "meeting.list", json!({}));
    assert_eq!(reply["result"]["meetings"][0]["state"], "done");
}

#[test]
fn a_recorder_crash_leaves_a_gap_mark_and_no_passage_twice() {
    recorder_exe();
    let m = Meeting::new("crash");
    let mut rukoo = Rukoo::connect(&m.discovery);
    let mut recorder = Running(Some(m.record(false)));
    let pipeline = m.pipeline();
    rukoo.read_until("a passage before the crash", |events| {
        !data_of(events, "passage").is_empty()
    });

    // A hard kill, the way a crash ends the recorder.
    let mut child = recorder.0.take().unwrap();
    child.kill().unwrap();
    child.wait().unwrap();
    // The app restarts too: a new pipeline takes over from transcript.db.
    pipeline.shutdown();
    std::thread::sleep(Duration::from_millis(1500));
    let pipeline = m.pipeline();
    recorder.0 = Some(m.record(true));
    let resumed_at = wait_until("the resumed session", WAIT, || {
        m.timeline()
            .iter()
            .find(|l| l["kind"] == "crash")
            .and_then(|l| l["t"].as_u64())
    });
    m.wait_for_heartbeat(resumed_at + 3000);
    rukoo.read_until("a passage after the resume", |events| {
        data_of(events, "passage")
            .iter()
            .any(|p| p["start"].as_u64() > Some(resumed_at))
    });
    m.stop(recorder.0.as_mut().unwrap());
    rukoo.read_until("done", |events| {
        position(events, |e| is_state(e, "done")).is_some()
    });
    pipeline.shutdown();

    let events = &rukoo.events;
    let crash = m
        .timeline()
        .into_iter()
        .find(|l| l["kind"] == "crash")
        .unwrap();
    let gaps: Vec<&Value> = data_of(events, "mark")
        .into_iter()
        .filter(|k| k["kind"] == "gap")
        .collect();
    assert_eq!(gaps.len(), 1, "{gaps:?}");
    assert_eq!(
        gaps[0],
        &json!({
            "id": format!("gap-all-{}", crash["lastSeen"]),
            "kind": "gap",
            "at": crash["lastSeen"],
            "until": crash["t"],
            "track": null,
            "detail": "crash",
            "label": null,
        })
    );
    let passages = data_of(events, "passage");
    let mut seen = HashSet::new();
    for p in &passages {
        assert!(
            seen.insert((p["id"].as_str().unwrap(), p["revision"].as_u64().unwrap())),
            "sent twice: {p}"
        );
        // No passage claims the time the recorder was down.
        let (start, end) = (p["start"].as_u64().unwrap(), p["end"].as_u64().unwrap());
        let (lost, back) = (
            crash["lastSeen"].as_u64().unwrap(),
            crash["t"].as_u64().unwrap(),
        );
        assert!(
            end <= lost + 1000 || start >= back,
            "{p} overlaps {lost}..{back}"
        );
    }
    assert_eq!(seen.len(), passages.len());
    assert!(passages
        .iter()
        .any(|p| p["start"].as_u64() < Some(resumed_at)));
    assert!(passages
        .iter()
        .any(|p| p["start"].as_u64() > Some(resumed_at)));
    assert_eq!(
        data_of(events, "meeting.state")
            .iter()
            .map(|s| s["state"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["recording", "processing", "done"]
    );
}
