//! What the engine needs from the computer, behind traits so tests never touch the real
//! keyboard, clipboard, microphone, speakers, registry or network.
//!
//! [`Services::system`] wires the real ones; tests build a [`Services`] of fakes and start the
//! engine with [`crate::start_with`].

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

use voice_core::local::{
    LocalEngine, LocalOptions, LocalStatus, Located, ModelError, ModelRegistry, ModelSpec, Progress,
};
use voice_core::providers::{Activity, ProviderConfig};
use voice_core::{ProviderError, Rewriter, SpeechToText};
use voice_input::{InputError, InsertMode, Key, TextTarget};

use crate::api::{EngineOptions, Locale, Theme};
use crate::meetings::controller::ControllerTiming;

/// Whether a key is physically down.
pub type KeyState = Arc<dyn Fn(Key) -> bool + Send + Sync>;

/// Text into the focused app, and the selection out of it.
pub trait TextInput: Send + Sync {
    fn insert(&self, text: &str, mode: InsertMode) -> Result<(), InputError>;
    fn capture_selection(&self, timeout: Duration) -> Result<Option<String>, InputError>;
    fn text_target(&self) -> TextTarget;
    /// Before quitting, so the user's clipboard comes back.
    fn wait_for_clipboard_restore(&self) {}
}

/// Blocks of 16 kHz mono samples, as they are captured.
pub type AudioSink = Box<dyn FnMut(&[i16]) + Send>;

/// An open microphone. Dropping it stops the capture.
pub trait MicStream: Send {}

pub trait Microphone: Send + Sync {
    /// Opens the default microphone; blocks until it is open or failed. The error is an English
    /// sentence for the notification.
    fn open(&self, on_audio: AudioSink) -> Result<Box<dyn MicStream>, String>;
}

/// Speech and rewrite providers, and the local model.
pub trait Speech: Send + Sync {
    fn recognizer(&self, cfg: &ProviderConfig) -> Result<Arc<dyn SpeechToText>, ProviderError>;
    fn rewriter(&self, cfg: &ProviderConfig) -> Result<Arc<dyn Rewriter>, ProviderError>;
    fn list_models(
        &self,
        activity: Activity,
        cfg: &ProviderConfig,
    ) -> Result<Vec<String>, ProviderError>;
    /// Starts loading Orukeet in the background, at a press.
    fn local_preload(&self);
    fn local_status(&self) -> LocalStatus;
    /// Switches Orukeet to `registry` and loads it now. On failure the old location stays.
    fn local_load(&self, registry: ModelRegistry) -> Result<(), ProviderError>;
    /// Where Orukeet is looked for and how long it stays loaded, after a Settings change.
    fn local_configure(&self, registry: ModelRegistry, idle: Duration);
    fn local_unload(&self);
    fn download(
        &self,
        registry: &ModelRegistry,
        spec: &ModelSpec,
        progress: &mut dyn FnMut(Progress),
        cancel: &AtomicBool,
    ) -> Result<Located, ModelError>;
    fn shutdown(&self);
}

pub trait Chime: Send + Sync {
    /// The ready chime: Windows' "Asterisk" sound, asynchronous.
    fn play(&self);
}

/// The HKCU Run value.
pub trait Autostart: Send + Sync {
    fn is_on(&self) -> bool;
    fn set(&self, on: bool) -> Result<(), String>;
}

pub trait Updates: Send + Sync {
    /// The newer Voice version on GitHub, `None` when this one is the newest.
    fn check(&self, current: &str) -> Result<Option<String>, String>;
}

/// What the engine reads from the system: the theme, the language, Ownkey's process, disk space.
pub trait System: Send + Sync {
    fn theme(&self) -> Theme;
    fn locale(&self) -> Locale;
    fn ownkey_running(&self) -> bool;
    fn free_bytes(&self, path: &Path) -> Option<u64>;
}

/// Everything [`crate::start_with`] runs on.
pub struct Services {
    /// `None` reads the real keyboard through voice-input's poller; tests inject the key state.
    pub key_state: Option<KeyState>,
    pub hotkey_interval: Duration,
    pub input: Arc<dyn TextInput>,
    pub microphone: Arc<dyn Microphone>,
    pub speech: Arc<dyn Speech>,
    pub chime: Arc<dyn Chime>,
    pub autostart: Arc<dyn Autostart>,
    pub updates: Arc<dyn Updates>,
    pub system: Arc<dyn System>,
    /// Ownkey's settings, read only by the import.
    pub ownkey_config: Option<PathBuf>,
    /// Ownkey's model folder, read only.
    pub ownkey_models: Option<PathBuf>,
    pub recorder_exe: PathBuf,
    /// `None`: PROTOCOL.md's path for this data folder (`RUKOO_VOICE_BRIDGE` still wins).
    pub discovery_path: Option<PathBuf>,
    pub controller: ControllerTiming,
}

impl Services {
    /// The real computer.
    pub fn system(options: &EngineOptions) -> Services {
        let ownkey_models = voice_core::paths::ownkey_models();
        let registry =
            ModelRegistry::new(&options.data_dir).with_ownkey_models(ownkey_models.clone());
        let mut local = LocalOptions::new(registry);
        let worker = options.exe_dir.join(voice_core::paths::LOCAL_EXE_NAME);
        if worker.is_file() {
            local.worker_exe = Some(worker);
        }
        Services {
            key_state: None,
            hotkey_interval: voice_input::POLL_INTERVAL,
            input: Arc::new(SystemInput),
            microphone: Arc::new(crate::dictation::capture::DefaultMicrophone),
            speech: Arc::new(SystemSpeech {
                local: LocalEngine::new(local),
            }),
            chime: Arc::new(crate::platform::SystemChime),
            autostart: Arc::new(crate::autostart::RunValue::for_current_exe()),
            updates: Arc::new(GitHubUpdates),
            system: Arc::new(crate::platform::SystemInfo),
            ownkey_config: voice_core::paths::ownkey_config(),
            ownkey_models,
            recorder_exe: options.exe_dir.join(RECORDER_EXE),
            discovery_path: None,
            controller: ControllerTiming::default(),
        }
    }
}

#[cfg(windows)]
pub const RECORDER_EXE: &str = "rukoo-voice-recorder.exe";
#[cfg(not(windows))]
pub const RECORDER_EXE: &str = "rukoo-voice-recorder";

struct SystemInput;

impl TextInput for SystemInput {
    fn insert(&self, text: &str, mode: InsertMode) -> Result<(), InputError> {
        voice_input::insert_text(text, mode)
    }

    fn capture_selection(&self, timeout: Duration) -> Result<Option<String>, InputError> {
        voice_input::capture_selection(timeout)
    }

    fn text_target(&self) -> TextTarget {
        voice_input::text_target()
    }

    fn wait_for_clipboard_restore(&self) {
        voice_input::wait_for_clipboard_restore();
    }
}

struct SystemSpeech {
    local: LocalEngine,
}

impl Speech for SystemSpeech {
    fn recognizer(&self, cfg: &ProviderConfig) -> Result<Arc<dyn SpeechToText>, ProviderError> {
        voice_core::speech_to_text(cfg, &self.local).map(Arc::from)
    }

    fn rewriter(&self, cfg: &ProviderConfig) -> Result<Arc<dyn Rewriter>, ProviderError> {
        voice_core::rewriter(cfg).map(Arc::from)
    }

    fn list_models(
        &self,
        activity: Activity,
        cfg: &ProviderConfig,
    ) -> Result<Vec<String>, ProviderError> {
        voice_core::list_models(activity, cfg)
    }

    fn local_preload(&self) {
        self.local.preload();
    }

    fn local_status(&self) -> LocalStatus {
        self.local.status()
    }

    fn local_load(&self, registry: ModelRegistry) -> Result<(), ProviderError> {
        let before = self.local.registry();
        self.local.set_registry(registry);
        let result = self.local.load();
        if result.is_err() {
            self.local.set_registry(before);
        }
        result
    }

    fn local_configure(&self, registry: ModelRegistry, idle: Duration) {
        self.local.set_registry(registry);
        self.local.set_idle_timeout(idle);
    }

    fn local_unload(&self) {
        self.local.unload();
    }

    fn download(
        &self,
        registry: &ModelRegistry,
        spec: &ModelSpec,
        progress: &mut dyn FnMut(Progress),
        cancel: &AtomicBool,
    ) -> Result<Located, ModelError> {
        registry.download(spec, progress, cancel)
    }

    fn shutdown(&self) {
        self.local.shutdown();
    }
}

struct GitHubUpdates;

impl Updates for GitHubUpdates {
    fn check(&self, current: &str) -> Result<Option<String>, String> {
        voice_core::update::check(current)
            .map(|release| release.map(|r| r.version))
            .map_err(|e| e.to_string())
    }
}
