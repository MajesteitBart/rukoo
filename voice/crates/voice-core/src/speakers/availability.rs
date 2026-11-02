//! Whether speaker labels can run on this computer, answered without starting a process, and what
//! Voice remembers about failed workers until it restarts.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde::Serialize;

use super::api::Diarizer;
use super::runtime::RuntimeInfo;
use crate::local::ModelRegistry;

/// Why speaker labels can't run. Serialized with the Settings reason code in `code`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum Unavailable {
    /// Not Windows on x86-64.
    Platform,
    /// The processor lacks features the runtime needs.
    Cpu { missing: Vec<String> },
    /// No runtime folder verifies.
    Runtime,
    /// A worker refused to load the runtime or the model, or crashed while loading, since Voice
    /// started.
    RuntimeFailed { detail: String },
    /// The Nemotron model isn't installed.
    Model,
    /// The model failed its check since Voice started.
    ModelDamaged { detail: String },
}

impl Unavailable {
    /// The Settings reason code: the same string as the serialized `code`.
    pub fn code(&self) -> &'static str {
        match self {
            Unavailable::Platform => "platform",
            Unavailable::Cpu { .. } => "cpu",
            Unavailable::Runtime => "runtime",
            Unavailable::RuntimeFailed { .. } => "runtimeFailed",
            Unavailable::Model => "model",
            Unavailable::ModelDamaged { .. } => "modelDamaged",
        }
    }
}

/// How [`SpeakerLabels`] finds and runs the worker.
#[derive(Clone, Debug)]
pub struct SpeakerOptions {
    /// None: `RUKOO_VOICE_SPEAKERS_EXE`, then `rukoo-voice-speakers` next to the running exe.
    pub worker_exe: Option<PathBuf>,
    /// The folder the runtime is looked for in, as `nemo_speech\`.
    pub exe_dir: PathBuf,
    pub registry: ModelRegistry,
    pub dev_mode: bool,
    pub start_timeout: Duration,
    pub load_timeout: Duration,
    pub push_timeout: Duration,
    pub finish_timeout: Duration,
}

impl SpeakerOptions {
    pub fn new(exe_dir: impl Into<PathBuf>, registry: ModelRegistry) -> SpeakerOptions {
        SpeakerOptions {
            worker_exe: None,
            exe_dir: exe_dir.into(),
            registry,
            dev_mode: false,
            start_timeout: Duration::from_secs(10),
            load_timeout: Duration::from_secs(60),
            push_timeout: Duration::from_secs(30),
            finish_timeout: Duration::from_secs(60),
        }
    }
}

/// One per process: answers whether labels can run and opens diarizers for meetings.
#[derive(Clone)]
pub struct SpeakerLabels {
    inner: Arc<Inner>,
}

struct Inner {
    opts: Mutex<SpeakerOptions>,
}

impl SpeakerLabels {
    pub fn new(opts: SpeakerOptions) -> SpeakerLabels {
        SpeakerLabels {
            inner: Arc::new(Inner {
                opts: Mutex::new(opts),
            }),
        }
    }

    /// Whether labels can run now: platform, processor, remembered failures, runtime and model.
    /// Cheap enough for every Settings refresh; starts no process.
    pub fn availability(&self) -> Result<RuntimeInfo, Unavailable> {
        // Placeholder until the checks land: no runtime verifies.
        Err(Unavailable::Runtime)
    }

    /// A diarizer for one meeting, or why there is none.
    pub fn diarizer(&self) -> Result<Arc<dyn Diarizer>, Unavailable> {
        // Placeholder until the worker client lands.
        Err(Unavailable::Runtime)
    }

    /// Where the model is looked for, after a Settings change.
    pub fn set_registry(&self, registry: ModelRegistry) {
        self.inner
            .opts
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .registry = registry;
    }
}
