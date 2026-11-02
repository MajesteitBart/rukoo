//! Speaker labels through the engine, on fakes: who labels a meeting, what Settings says about
//! it, and that Nemotron never hands a meeting to Mistral.
//!
//! No recorder runs. Each meeting is written the way the recorder writes one, stopped, before
//! the engine starts; the engine then transcribes it as a meeting that was cut off.

mod support;

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};
use support::{lock, wait_for, Harness, SpeechHandle};
use voice_audio::SegmentWriter;
use voice_bridge::{EventLog, Stored};
use voice_core::local::{LocalStatus, Located, ModelError, ModelRegistry, ModelSpec, Progress};
use voice_core::providers::stream::{SpeechStream, StreamSession, StreamingSpeech};
use voice_core::providers::{Activity, ProviderConfig};
use voice_core::speakers::{
    DiarError, DiarErrorKind, DiarStream, Diarizer, RuntimeInfo, RuntimeLocation, Unavailable,
};
use voice_core::{ProviderError, Rewriter, SpeechToText};
use voice_engine::meetings::PipelineOptions;
use voice_engine::services::Speech;
use voice_meetings::{CreateMeeting, Library};
use voice_protocol::{ScreenMode, StartedBy, Track};

const SECRET: &str = "sk-test-0123456789";
const REALTIME: &str = "voxtral-mini-transcribe-realtime-3";
const COMMIT: &str = "97a15afa5caa9bce5baaa86c1184103877af4101";

// Fakes ---------------------------------------------------------------------------------------

/// A door the fake diarizer's `open` waits at, so a meeting stays "labelling" while a test looks.
#[derive(Default)]
struct Door {
    opened: Mutex<bool>,
    changed: Condvar,
}

impl Door {
    fn close(&self) {
        *lock(&self.opened) = false;
    }

    fn open(&self) {
        *lock(&self.opened) = true;
        self.changed.notify_all();
    }

    fn wait(&self) {
        let mut opened = lock(&self.opened);
        while !*opened {
            opened = self
                .changed
                .wait(opened)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
    }
}

/// Opens the door again when a test ends, also when it fails, so no thread waits forever.
struct OpenOnDrop(Arc<Door>);

impl Drop for OpenOnDrop {
    fn drop(&mut self) {
        self.0.open();
    }
}

/// A diarizer whose streams never open: the runtime refuses, after the door opens.
struct FakeDiarizer {
    door: Arc<Door>,
    opens: Arc<AtomicUsize>,
}

impl Diarizer for FakeDiarizer {
    fn open(&self) -> Result<Box<dyn DiarStream>, DiarError> {
        self.opens.fetch_add(1, Ordering::SeqCst);
        self.door.wait();
        Err(DiarError::new(
            DiarErrorKind::Runtime,
            "The fake runtime doesn't run.",
        ))
    }
}

/// A realtime model that counts connections and accepts none.
struct FakeStream {
    connects: Arc<AtomicUsize>,
}

impl StreamingSpeech for FakeStream {
    fn connect(&self, _session: &StreamSession) -> Result<Box<dyn SpeechStream>, ProviderError> {
        self.connects.fetch_add(1, Ordering::SeqCst);
        Err(ProviderError::provider("The fake stream accepts nothing."))
    }
}

/// The harness's speech, plus Nemotron and Mistral's stream as each test sets them up.
struct Labelling {
    base: SpeechHandle,
    availability: Mutex<Result<RuntimeInfo, Unavailable>>,
    /// `None`: a diarizer is handed out.
    refuse: Mutex<Option<Unavailable>>,
    door: Arc<Door>,
    diarizers: AtomicUsize,
    opens: Arc<AtomicUsize>,
    streams: AtomicUsize,
    connects: Arc<AtomicUsize>,
}

impl Labelling {
    fn new(base: SpeechHandle) -> Labelling {
        let door = Arc::new(Door::default());
        door.open();
        Labelling {
            base,
            availability: Mutex::new(Err(Unavailable::Platform)),
            refuse: Mutex::new(Some(Unavailable::Platform)),
            door,
            diarizers: AtomicUsize::new(0),
            opens: Arc::new(AtomicUsize::new(0)),
            streams: AtomicUsize::new(0),
            connects: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// Nemotron can't run here, for this reason, both for Settings and for meetings.
    fn unavailable(&self, why: Unavailable) {
        *lock(&self.availability) = Err(why.clone());
        *lock(&self.refuse) = Some(why);
    }

    /// Nemotron can run, from Voice's own runtime.
    fn ready(&self) {
        *lock(&self.availability) = Ok(RuntimeInfo {
            dir: PathBuf::from("nemo_speech"),
            location: RuntimeLocation::Voice,
            commit: COMMIT.into(),
        });
        *lock(&self.refuse) = None;
    }
}

impl Speech for Labelling {
    fn recognizer(&self, cfg: &ProviderConfig) -> Result<Arc<dyn SpeechToText>, ProviderError> {
        self.base.recognizer(cfg)
    }

    fn meeting_recognizer(&self, cfg: &ProviderConfig) -> Result<PipelineOptions, ProviderError> {
        self.base.meeting_recognizer(cfg)
    }

    fn rewriter(&self, cfg: &ProviderConfig) -> Result<Arc<dyn Rewriter>, ProviderError> {
        self.base.rewriter(cfg)
    }

    fn list_models(
        &self,
        activity: Activity,
        cfg: &ProviderConfig,
    ) -> Result<Vec<String>, ProviderError> {
        self.base.list_models(activity, cfg)
    }

    fn local_preload(&self) {
        self.base.local_preload();
    }

    fn local_status(&self) -> LocalStatus {
        self.base.local_status()
    }

    fn local_load(&self, registry: ModelRegistry) -> Result<(), ProviderError> {
        self.base.local_load(registry)
    }

    fn local_configure(&self, registry: ModelRegistry, idle: Duration) {
        self.base.local_configure(registry, idle);
    }

    fn local_unload(&self) {
        self.base.local_unload();
    }

    fn download(
        &self,
        registry: &ModelRegistry,
        spec: &ModelSpec,
        progress: &mut dyn FnMut(Progress),
        cancel: &AtomicBool,
    ) -> Result<Located, ModelError> {
        self.base.download(registry, spec, progress, cancel)
    }

    fn shutdown(&self) {
        self.base.shutdown();
    }

    fn diarizer(&self) -> Result<Arc<dyn Diarizer>, Unavailable> {
        self.diarizers.fetch_add(1, Ordering::SeqCst);
        match lock(&self.refuse).clone() {
            Some(why) => Err(why),
            None => Ok(Arc::new(FakeDiarizer {
                door: Arc::clone(&self.door),
                opens: Arc::clone(&self.opens),
            })),
        }
    }

    fn speaker_availability(&self) -> Result<RuntimeInfo, Unavailable> {
        lock(&self.availability).clone()
    }

    fn streaming(&self, _cfg: &ProviderConfig) -> Result<Arc<dyn StreamingSpeech>, ProviderError> {
        self.streams.fetch_add(1, Ordering::SeqCst);
        Ok(Arc::new(FakeStream {
            connects: Arc::clone(&self.connects),
        }))
    }
}

/// Starts the engine on the harness's fakes with `speech` for speech.
fn start(h: &Harness, speech: &Arc<Labelling>) -> voice_engine::Engine {
    let mut services = h.services();
    services.speech = Arc::clone(speech) as Arc<dyn Speech>;
    voice_engine::start_with(h.options(), h.sink.clone(), services).expect("the engine starts")
}

fn labelling(h: &Harness) -> Arc<Labelling> {
    Arc::new(Labelling::new(SpeechHandle(Arc::clone(&h.speech))))
}

// A recorded meeting --------------------------------------------------------------------------

/// Loud square waves: something for every window to transcribe.
fn tone(seconds: usize) -> Vec<i16> {
    (0..seconds * 16_000)
        .map(|i| if (i / 27) % 2 == 0 { 4000 } else { -4000 })
        .collect()
}

/// A stopped two-track meeting of 3 s, written as the recorder writes one.
fn record_meeting(data: &Path) -> String {
    let library = Library::open(data).unwrap();
    let dir = library
        .create(&CreateMeeting {
            title: "Planning".into(),
            tracks: vec![Track::Mic, Track::Call],
            sources: Default::default(),
            screen: ScreenMode::Off,
            started_by: StartedBy::Voice,
            context: None,
        })
        .unwrap();
    let mut timeline = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.path().join("timeline.jsonl"))
        .unwrap();
    let mut line = |value: Value| {
        timeline.write_all(format!("{value}\n").as_bytes()).unwrap();
    };
    line(
        json!({"kind": "session", "t": 0, "wall": 1_793_000_000_000u64, "session": 1, "pid": 1, "resumed": false, "version": 1}),
    );
    for track in ["mic", "call"] {
        let file = format!("audio/{track}/000001.wav");
        let path = dir.path().join(&file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut writer = SegmentWriter::create(&path).unwrap();
        line(json!({"kind": "segment", "t": 0, "track": track, "seq": 1, "file": file}));
        writer.append(&tone(3)).unwrap();
        let samples = writer.close().unwrap();
        line(
            json!({"kind": "segment_end", "t": samples / 16, "track": track, "seq": 1, "samples": samples}),
        );
    }
    line(json!({"kind": "stop", "t": 3000, "wall": 1_793_000_003_000u64, "reason": "user"}));
    dir.id().to_string()
}

fn events(data: &Path, id: &str) -> Vec<Stored> {
    EventLog::open(data).unwrap().meeting_events(id).unwrap().1
}

fn wait_done(data: &Path, id: &str) -> Vec<Stored> {
    wait_for("meeting.state done", || {
        events(data, id)
            .iter()
            .any(|e| e.event == "meeting.state" && e.data["state"] == "done")
    });
    events(data, id)
}

/// A meeting without speaker labels: You, and the whole call as Speaker 1.
fn assert_one_call_speaker(events: &[Stored]) {
    let speakers: Vec<&Value> = events
        .iter()
        .filter(|e| e.event == "speaker")
        .map(|e| &e.data)
        .collect();
    assert_eq!(
        speakers,
        [
            &json!({"id": "mic", "track": "mic", "label": "You"}),
            &json!({"id": "call-1", "track": "call", "label": "Speaker 1"}),
        ]
    );
    let calls: Vec<&Value> = events
        .iter()
        .filter(|e| e.event == "passage" && e.data["track"] == "call")
        .map(|e| &e.data)
        .collect();
    assert!(!calls.is_empty(), "the call was transcribed");
    for passage in calls {
        assert_eq!(passage["speaker"], "call-1", "{passage}");
    }
}

/// Voice's own copy of the Nemotron model, with the pinned size. Its bytes don't matter here.
fn own_nemotron(data: &Path) -> PathBuf {
    let spec = ModelSpec::nemotron();
    let dir = spec.install_dir(&voice_core::paths::models_dir(data));
    fs::create_dir_all(&dir).unwrap();
    let file = dir.join(&spec.files[0].name);
    fs::File::create(&file)
        .unwrap()
        .set_len(spec.files[0].size)
        .unwrap();
    file
}

// Tests ---------------------------------------------------------------------------------------

#[test]
fn a_processor_nemotron_can_t_use_records_the_call_as_one_speaker() {
    let h = Harness::new("speakers-cpu");
    h.config(json!({}));
    let speech = labelling(&h);
    speech.unavailable(Unavailable::Cpu {
        missing: vec!["bmi2".into()],
    });
    let id = record_meeting(&h.data());
    let engine = start(&h, &speech);
    let state = engine.settings_state();
    assert_eq!(state["speakers"]["engine"], "nemotron");
    assert_eq!(state["speakers"]["ready"], false);
    assert_eq!(state["speakers"]["reason"], "cpu");
    assert_eq!(state["speakers"]["missing"], json!(["bmi2"]));
    assert_eq!(state["speakers"]["runtime"], Value::Null);
    let events = wait_done(&h.data(), &id);
    assert_one_call_speaker(&events);
    assert!(
        speech.diarizers.load(Ordering::SeqCst) >= 1,
        "the meeting asked"
    );
    assert_eq!(speech.opens.load(Ordering::SeqCst), 0);
    assert_eq!(speech.streams.load(Ordering::SeqCst), 0);
    engine.shutdown();
}

#[test]
fn nemotron_that_can_t_run_never_falls_back_to_mistral() {
    let h = Harness::new("speakers-no-fallback");
    // Mistral is set up for dictation, with a key; meetings stay on this computer.
    h.config(json!({
        "audio_provider": "mistral",
        "audio_api_key": SECRET,
        "audio_endpoint": "https://api.mistral.ai/v1/audio/transcriptions",
        "audio_model": "voxtral-mini-latest",
        "meetings_audio_provider": "orukeet",
    }));
    let speech = labelling(&h);
    speech.unavailable(Unavailable::Runtime);
    let id = record_meeting(&h.data());
    let engine = start(&h, &speech);
    assert_eq!(engine.settings_state()["speakers"]["reason"], "runtime");
    let events = wait_done(&h.data(), &id);
    assert_one_call_speaker(&events);
    assert!(speech.diarizers.load(Ordering::SeqCst) >= 1);
    assert_eq!(
        speech.streams.load(Ordering::SeqCst),
        0,
        "no stream was built"
    );
    assert_eq!(
        speech.connects.load(Ordering::SeqCst),
        0,
        "nothing streamed"
    );
    let providers = lock(&h.speech.meeting_providers).clone();
    assert!(
        !providers.is_empty() && providers.iter().all(|p| p == "orukeet"),
        "{providers:?}"
    );
    engine.shutdown();
}

#[test]
fn a_realtime_meeting_waits_for_consent_to_stream() {
    let h = Harness::new("speakers-consent");
    h.config(json!({
        "meetings_audio_provider": "mistral",
        "meetings_audio_api_key": SECRET,
        "meetings_audio_endpoint": "https://api.mistral.ai/v1/audio/transcriptions",
        "meetings_audio_model": REALTIME,
    }));
    let speech = labelling(&h);
    speech.ready();
    let id = record_meeting(&h.data());
    let engine = start(&h, &speech);
    let state = engine.settings_state();
    assert_eq!(state["speakers"]["engine"], "mistral");
    assert_eq!(state["speakers"]["ready"], false);
    assert_eq!(state["speakers"]["reason"], "consent");
    // The meeting got the stream, and its consent check holds everything back.
    wait_for("the meeting's options", || {
        speech.streams.load(Ordering::SeqCst) >= 1
    });
    wait_for("the meeting to begin", || {
        events(&h.data(), &id)
            .iter()
            .any(|e| e.event == "meeting.started")
    });
    thread::sleep(Duration::from_millis(1500));
    assert!(
        !events(&h.data(), &id).iter().any(|e| e.event == "passage"),
        "nothing was transcribed"
    );
    assert!(
        lock(&h.speech.meeting_heard).is_empty(),
        "no window went out"
    );
    assert_eq!(
        speech.connects.load(Ordering::SeqCst),
        0,
        "nothing streamed"
    );
    assert_eq!(
        speech.diarizers.load(Ordering::SeqCst),
        0,
        "Mistral labels these meetings, not Nemotron"
    );
    // Agreeing makes labels ready.
    engine
        .settings_save_provider(json!({
            "target": "meetings", "provider": "mistral",
            "endpoint": "https://api.mistral.ai/v1/audio/transcriptions",
            "model": REALTIME, "apiKey": null, "consent": true
        }))
        .unwrap();
    let state = engine.settings_state();
    assert_eq!(state["speakers"]["ready"], true);
    assert_eq!(state["speakers"]["reason"], Value::Null);
    engine.shutdown();
}

#[test]
fn an_agreement_for_windows_doesn_t_cover_a_stream() {
    let h = Harness::new("speakers-windows-agreement");
    h.config(json!({
        "meetings_audio_provider": "mistral",
        "meetings_audio_api_key": SECRET,
        "meetings_audio_endpoint": "https://api.mistral.ai/v1/audio/transcriptions",
        "meetings_audio_model": REALTIME,
        "meetings_transcription_consent": {"provider": "mistral", "host": "api.mistral.ai"},
    }));
    let speech = labelling(&h);
    speech.ready();
    let id = record_meeting(&h.data());
    let engine = start(&h, &speech);
    let state = engine.settings_state();
    // An agreement from Voice 0.1 or a batch model covers recorded windows only.
    assert_eq!(state["config"]["meetings"]["consent"]["mode"], "windows");
    assert_eq!(state["speakers"]["reason"], "consent");
    let refused = voice_engine::meetings::transcription_allowed(&h.saved_config()).unwrap_err();
    assert!(
        refused.contains("streaming meeting audio to Mistral at api.mistral.ai"),
        "{refused}"
    );
    wait_for("the meeting to begin", || {
        events(&h.data(), &id)
            .iter()
            .any(|e| e.event == "meeting.started")
    });
    thread::sleep(Duration::from_millis(1500));
    assert!(
        !events(&h.data(), &id).iter().any(|e| e.event == "passage"),
        "nothing was transcribed"
    );
    assert_eq!(
        speech.connects.load(Ordering::SeqCst),
        0,
        "nothing streamed"
    );
    // Agreeing to stream stores a stream agreement and makes labels ready.
    engine
        .settings_save_provider(json!({
            "target": "meetings", "provider": "mistral",
            "endpoint": "https://api.mistral.ai/v1/audio/transcriptions",
            "model": REALTIME, "apiKey": null, "consent": true
        }))
        .unwrap();
    let state = engine.settings_state();
    assert_eq!(state["config"]["meetings"]["consent"]["mode"], "stream");
    assert_eq!(state["speakers"]["ready"], true);
    assert!(voice_engine::meetings::transcription_allowed(&h.saved_config()).is_ok());
    engine.shutdown();
}

#[test]
fn the_switch_off_never_asks_nemotron() {
    let h = Harness::new("speakers-off");
    h.config(json!({"meetings_live_speakers": false}));
    let speech = labelling(&h);
    speech.ready();
    let id = record_meeting(&h.data());
    let engine = start(&h, &speech);
    let state = engine.settings_state();
    assert_eq!(state["config"]["meetings"]["liveSpeakers"], false);
    assert_eq!(state["speakers"]["ready"], false);
    assert_eq!(state["speakers"]["reason"], "off");
    let events = wait_done(&h.data(), &id);
    assert_one_call_speaker(&events);
    assert_eq!(speech.diarizers.load(Ordering::SeqCst), 0);
    assert_eq!(speech.streams.load(Ordering::SeqCst), 0);
    engine.shutdown();
}

#[test]
fn settings_name_the_runtime_nemotron_runs_from() {
    let h = Harness::new("speakers-ready");
    h.config(json!({}));
    let speech = labelling(&h);
    speech.ready();
    let engine = start(&h, &speech);
    let state = engine.settings_state();
    assert_eq!(state["speakers"]["engine"], "nemotron");
    assert_eq!(state["speakers"]["ready"], true);
    assert_eq!(state["speakers"]["reason"], Value::Null);
    assert_eq!(state["speakers"]["detail"], Value::Null);
    assert_eq!(
        state["speakers"]["runtime"],
        json!({"location": "voice", "commit": "97a15af"})
    );
    // A worker that failed since Voice started: Settings says so and has the error.
    speech.unavailable(Unavailable::RuntimeFailed {
        detail: "nemo_speech_asr_c.dll couldn't be loaded.".into(),
    });
    engine.settings_set("ui.theme", json!("light")).unwrap();
    let state = h.sink.last_settings();
    assert_eq!(state["speakers"]["reason"], "runtimeFailed");
    assert_eq!(
        state["speakers"]["detail"],
        "nemo_speech_asr_c.dll couldn't be loaded."
    );
    engine.shutdown();
}

#[test]
fn voice_s_own_nemotron_copy_is_removed_when_no_meeting_labels() {
    let h = Harness::new("speakers-remove");
    h.config(json!({}));
    let file = own_nemotron(&h.data());
    let speech = labelling(&h);
    speech.ready();
    let engine = start(&h, &speech);
    let model = engine.settings_state()["models"]["nemotron"].clone();
    assert_eq!(model["stage"], "installed");
    assert_eq!(model["location"], "voice");
    assert_eq!(model["removable"], true);
    engine.settings_model("nemotron", "remove").unwrap();
    assert!(!file.exists());
    assert_eq!(
        engine.settings_state()["models"]["nemotron"]["stage"],
        "missing"
    );
    engine.shutdown();
}

#[test]
fn removing_nemotron_waits_while_a_meeting_labels() {
    let h = Harness::new("speakers-busy");
    h.config(json!({}));
    let file = own_nemotron(&h.data());
    let speech = labelling(&h);
    speech.ready();
    speech.door.close();
    let _id = record_meeting(&h.data());
    let engine = start(&h, &speech);
    // Declared after the engine, so a failing assertion opens the door before the engine's drop
    // waits for the meeting's pipeline to stop.
    let _door = OpenOnDrop(Arc::clone(&speech.door));
    // The meeting's labels start: its stream is opening.
    wait_for("the diarizer to open", || {
        speech.opens.load(Ordering::SeqCst) >= 1
    });
    let refused = engine.settings_model("nemotron", "remove").unwrap_err();
    assert_eq!(refused.code, "busy");
    assert_eq!(
        refused.message,
        "A meeting is labelling speakers with this model."
    );
    assert!(file.exists());
    // The runtime refuses; labels stop for that meeting, and the model can go.
    speech.door.open();
    wait_for("the model to be removable", || {
        engine.settings_model("nemotron", "remove").is_ok()
    });
    assert!(!file.exists());
    engine.shutdown();
}
