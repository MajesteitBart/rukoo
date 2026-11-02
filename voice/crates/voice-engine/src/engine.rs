//! The engine's shared state and the [`EngineApi`] the app drives.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard, OnceLock, PoisonError, RwLock, Weak};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;
use voice_bridge::ControlError;
use voice_core::config::{self as core_config, Config};
use voice_core::local::ModelRegistry;
use voice_core::{Hints, ProviderError, Recognized, SpeechToText};
use voice_input::Key;
use voice_protocol::{StartArgs, StartedBy};

use crate::api::{
    ApiError, EngineApi, EngineOptions, Folder, Locale, Notification, PillSnapshot, StopReason,
    Theme, TrayState, UiOptions, UiSink,
};
use crate::dictation::Dictation;
use crate::media::MediaService;
use crate::meetings::controller::Change;
use crate::meetings::{Meetings, PipelineOptions};
use crate::pill::{Looks, MeetingPhase, PillDriver};
use crate::platform::CHIME_COOLDOWN;
use crate::services::Services;
use crate::settings::SettingsRuntime;
use crate::sync::SyncRuntime;

/// Whether a meeting records the screen now (contract 2.7).
pub type ScreenRecording = Arc<dyn Fn() -> bool + Send + Sync>;

pub(crate) struct Core {
    pub opts: EngineOptions,
    pub svc: Services,
    pub sink: Arc<dyn UiSink>,
    config: RwLock<Arc<Config>>,
    /// Settings changes one at a time, so two saves can't undo each other.
    writing: Mutex<()>,
    pub pill: PillDriver,
    pub dictation: Dictation,
    pub settings: SettingsRuntime,
    pub meetings: Meetings,
    /// Bucket sync; `None` when its store didn't open, and Voice runs without it.
    pub sync: Option<Arc<voice_sync::BucketSync>>,
    pub sync_rt: SyncRuntime,
    /// `media.open` and `media.read` for the bridge.
    pub media: Arc<MediaService>,
    /// A stand-in that answers `false` until screen recording (RUK-108) is on this branch.
    pub screen_recording: ScreenRecording,
    shutting_down: AtomicBool,
    last_chime: Mutex<Option<Instant>>,
    /// What Settings > Rukoo last showed, to tell when it changes.
    rukoo: Mutex<Value>,
    pub settings_seq: AtomicU64,
    /// Settings states go out one at a time, each built after its `seq` was given.
    emitting: Mutex<()>,
    /// The engine itself, for work that outlives a call: set once by `start_with`.
    this: OnceLock<Weak<Core>>,
}

/// What [`Core::new`] gets besides the options and services.
pub(crate) struct Parts {
    pub config: Config,
    pub meetings: Meetings,
    pub settings: SettingsRuntime,
    pub sync: Option<Arc<voice_sync::BucketSync>>,
    pub media: Arc<MediaService>,
    pub screen_recording: ScreenRecording,
}

impl Core {
    pub fn new(opts: EngineOptions, svc: Services, sink: Arc<dyn UiSink>, parts: Parts) -> Core {
        let Parts {
            config,
            meetings,
            settings,
            sync,
            media,
            screen_recording,
        } = parts;
        let looks = looks(&opts, &svc, &config);
        Core {
            pill: PillDriver::new(looks, Arc::clone(&sink)),
            dictation: Dictation::new(&config, opts.dev_mode),
            config: RwLock::new(Arc::new(config)),
            writing: Mutex::new(()),
            settings,
            meetings,
            sync,
            sync_rt: SyncRuntime::default(),
            media,
            screen_recording,
            opts,
            svc,
            sink,
            shutting_down: AtomicBool::new(false),
            last_chime: Mutex::new(None),
            rukoo: Mutex::new(Value::Null),
            settings_seq: AtomicU64::new(1),
            emitting: Mutex::new(()),
            this: OnceLock::new(),
        }
    }

    pub fn set_this(self: &Arc<Self>) {
        let _ = self.this.set(Arc::downgrade(self));
    }

    fn this(&self) -> Option<Arc<Core>> {
        self.this.get().and_then(Weak::upgrade)
    }

    pub fn config(&self) -> Arc<Config> {
        Arc::clone(&self.config.read().unwrap_or_else(PoisonError::into_inner))
    }

    pub fn shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::SeqCst)
    }

    pub fn key_down(&self, key: Key) -> bool {
        match &self.svc.key_state {
            Some(state) => state(key),
            None => voice_input::is_key_down(key),
        }
    }

    /// Where Orukeet is looked for with these settings.
    pub fn registry(&self, cfg: &Config) -> ModelRegistry {
        ModelRegistry::for_config(&self.opts.data_dir, cfg)
            .with_ownkey_models(self.svc.ownkey_models.clone())
    }

    pub fn notify(&self, title_key: &str, body: String) {
        if !self.shutting_down() {
            self.sink.notify(Notification {
                title_key: title_key.to_string(),
                body,
            });
        }
    }

    /// The ready chime, read from the live settings as Ownkey did, at most every 0.2 s.
    pub fn play_chime(&self) {
        if !self.config().ready_chime {
            return;
        }
        let mut last = lock(&self.last_chime);
        if last.is_some_and(|at| at.elapsed() < CHIME_COOLDOWN) {
            return;
        }
        *last = Some(Instant::now());
        drop(last);
        self.svc.chime.play();
    }

    /// Changes Settings: checks, saves `config.json`, then applies the change everywhere. A
    /// failed check or save leaves the old settings in place.
    pub fn commit(
        &self,
        change: impl FnOnce(&mut Config) -> Result<(), ApiError>,
    ) -> Result<(), ApiError> {
        let _writing = lock(&self.writing);
        let old = self.config();
        let mut next = (*old).clone();
        change(&mut next)?;
        if next == *old {
            return Ok(());
        }
        next.save(&self.opts.data_dir)
            .map_err(|e| ApiError::new("failed", format!("Voice couldn't save Settings: {e}")))?;
        *self.config.write().unwrap_or_else(PoisonError::into_inner) = Arc::new(next.clone());
        self.apply(&old, &next);
        self.settings_changed();
        Ok(())
    }

    fn apply(&self, old: &Config, new: &Config) {
        self.dictation.apply(new, self.opts.dev_mode);
        self.svc
            .speech
            .local_configure(self.registry(new), new.idle_timeout());
        // Switching away from Orukeet frees its memory, unless meetings still use it.
        if old.audio_provider == "orukeet"
            && new.audio_provider != "orukeet"
            && new.meeting_audio().provider != "orukeet"
        {
            self.svc.speech.local_unload();
        }
        if old.meeting_audio() != new.meeting_audio() || old.meeting_hints() != new.meeting_hints()
        {
            // The pipelines were built for the old provider; they start again on the new one
            // and continue where transcript.db says. Shutting one down waits for its call.
            if let Some(core) = self.this() {
                let _ = thread::Builder::new()
                    .name("meeting-restart".into())
                    .spawn(move || {
                        let opts = || core.pipeline_options();
                        core.meetings.restart(opts);
                    });
            }
        } else if old.meetings_transcription_consent != new.meetings_transcription_consent {
            // Decision 10: transcription waited for this; it needn't wait for the next poll.
            self.meetings.wake();
        }
        // Keep audio applies to meetings started from now on; each keeps the choice it began with.
        self.meetings
            .library()
            .set_retention(new.meetings_retention);
        if old.extra.get(crate::sync::SYNC_KEY) != new.extra.get(crate::sync::SYNC_KEY) {
            crate::sync::configure_sync(self, new);
            // Held media may go now, for instance once sync is switched off.
            self.sync_rt.sweep_soon();
        }
        let before = looks(&self.opts, &self.svc, old);
        let after = looks(&self.opts, &self.svc, new);
        if before != after || old.pill_hide_from_capture != new.pill_hide_from_capture {
            self.pill.update(|p, _| p.set_looks(after));
            self.sink.ui_changed();
        }
    }

    /// Sends the whole Settings state with a new `seq`. One at a time: a state is built after its
    /// `seq` is given and sent before the next one is, so a state built from older Settings never
    /// carries the newest `seq` (API.md, `seq`). Callers hold none of the locks the state reads.
    pub fn settings_changed(&self) {
        if self.shutting_down() {
            return;
        }
        let _emitting = lock(&self.emitting);
        self.settings_seq.fetch_add(1, Ordering::SeqCst);
        self.sink.settings(crate::settings::state(self));
    }

    pub fn looks(&self) -> Looks {
        looks(&self.opts, &self.svc, &self.config())
    }

    pub fn tray(&self) -> TrayState {
        let recording = self.meetings.controller.current();
        TrayState {
            meeting: recording
                .as_ref()
                .map(|r| if r.paused { "paused" } else { "recording" }.to_string()),
            meeting_at_ms: recording.map(|r| r.at_ms),
            status: None,
        }
    }

    /// A click on the pill's stop button or the stop key: the first asks, the second stops.
    pub fn stop_clicked(self: &Arc<Self>) {
        let stop = self.pill.update(|p, now| p.stop_click(now));
        if !stop {
            return;
        }
        // The click comes from the app's window thread; stopping waits for the recorder.
        let core = Arc::clone(self);
        let _ = thread::Builder::new()
            .name("stop-meeting".into())
            .spawn(move || {
                if let Err(e) = core.meetings.controller.stop(None, "user") {
                    core.notify(
                        crate::meetings::controller::NOTIFY_MEETING,
                        format!("The meeting couldn't be stopped: {}", e.message),
                    );
                }
            });
    }

    /// How meetings are transcribed with the current Settings: the meeting provider (Orukeet
    /// with word timings), the dictionary as hints, and decision 10's consent gate.
    pub fn pipeline_options(self: &Arc<Self>) -> PipelineOptions {
        let cfg = self.config();
        let audio = cfg.meeting_audio();
        let mut opts = match self.svc.speech.meeting_recognizer(&audio) {
            Ok(opts) => opts,
            // A missing key or model: the pipeline retries while the meeting records and
            // reports this reason if it still fails after the stop.
            Err(error) => PipelineOptions::new(Arc::new(Unavailable(error))),
        };
        opts.hints = cfg.meeting_hints();
        let weak = Arc::downgrade(self);
        opts.transcription_allowed = Arc::new(move || {
            let Some(core) = weak.upgrade() else {
                return Err("Voice is quitting.".into());
            };
            let cfg = core.config();
            // Built for another provider: a restart with the new one is on its way, and no
            // audio goes to a provider the Settings no longer name.
            if cfg.meeting_audio() != audio {
                return Err("The meeting provider changed; transcription starts again.".into());
            }
            crate::meetings::transcription_allowed(&cfg)
        });
        opts
    }

    /// Transcribes a meeting for Rukoo.
    pub fn follow(self: &Arc<Self>, id: &str) {
        self.meetings.follow(id, self.pipeline_options());
    }

    /// What the meeting controller reports.
    pub fn on_meeting(self: &Arc<Self>, change: Change) {
        match change {
            Change::Started { id, at_ms } => {
                self.pill
                    .update(|p, now| p.meeting(&id, MeetingPhase::Recording, at_ms, now));
                self.follow(&id);
                self.nudge_sync();
                self.meeting_changed();
            }
            Change::Reattached { id, paused, at_ms } => {
                let phase = if paused {
                    MeetingPhase::Paused
                } else {
                    MeetingPhase::Recording
                };
                self.pill.update(|p, now| p.meeting(&id, phase, at_ms, now));
                self.follow(&id);
                self.meeting_changed();
            }
            Change::Paused { id, at_ms } => {
                self.pill
                    .update(|p, now| p.meeting(&id, MeetingPhase::Paused, at_ms, now));
                self.meeting_changed();
            }
            Change::Resumed { id, at_ms } => {
                self.pill
                    .update(|p, now| p.meeting(&id, MeetingPhase::Recording, at_ms, now));
                self.meeting_changed();
            }
            Change::Clock { at_ms, mic_ok, .. } => {
                self.pill.update(|p, now| {
                    p.meeting_clock(at_ms, now);
                    p.meeting_mic(mic_ok, now);
                });
                self.rukoo_changed();
            }
            Change::Restarted { .. } => {}
            Change::Ended { id, at_ms, .. } => {
                self.pill
                    .update(|p, now| p.meeting(&id, MeetingPhase::Processing, at_ms, now));
                // The last segments and the timeline closed.
                self.nudge_sync();
                self.meeting_changed();
            }
            Change::Finalized { id } => {
                // Cut off while Voice wasn't running: what was recorded still gets transcribed.
                self.follow(&id);
                self.notify(
                    crate::meetings::controller::NOTIFY_MEETING,
                    "A meeting was cut off last time. Everything recorded until then is saved."
                        .to_string(),
                );
            }
            Change::Notify { title_key, body } => self.notify(title_key, body),
        }
    }

    /// Tells Settings and the pill when Rukoo connects, leaves or is refused.
    pub fn rukoo_changed(&self) {
        let Some(bridge) = self.meetings.bridge.as_ref() else {
            return;
        };
        let info = bridge.rukoo();
        // `behind` moves with every event; Settings reads it with the next change.
        let key = serde_json::json!([info.state, info.client_version, info.protocol]);
        let changed = {
            let mut last = lock(&self.rukoo);
            let changed = *last != key;
            *last = key;
            changed
        };
        if changed {
            let connected = info.connected();
            self.pill.update(|p, _| p.set_rukoo(connected));
            self.settings_changed();
        }
    }

    /// Removes meeting audio whose retention ran out. Each meeting keeps the Settings > Meetings >
    /// Keep audio it started with; the current choice counts only for meetings from before Voice
    /// stored it.
    ///
    /// While bucket sync is on, media that hasn't reached the bucket stays, and with the switch on
    /// but sync's queue unreadable, all of it stays (spec 2.10). Below 10 GiB free that gives way:
    /// held media of meetings whose time is up goes, oldest first.
    pub fn sweep(&self) {
        let cfg = self.config();
        let switch_on = crate::sync::switch_on(&cfg);
        let sync = self.sync.as_deref();
        let swept = self.meetings.sweep(cfg.meetings_retention, |id| {
            crate::sync::holds(sync, switch_on, id)
        });
        if !swept.removed.is_empty() {
            log::info!(
                "retention: removed the audio of {}",
                swept.removed.join(", ")
            );
        }
        if !swept.held.is_empty() {
            log::info!(
                "retention: kept the media of {} for the bucket",
                swept.held.join(", ")
            );
        }
        let released = crate::sync::release_below_floor(self, &swept.held);
        crate::sync::note_held(self, !swept.held.is_empty());
        if !swept.removed.is_empty() || released {
            self.settings.forget_storage();
            self.settings_changed();
        }
    }

    /// Bucket sync's status changed: Settings show it, and held media may go now.
    ///
    /// Called on sync's own threads. The state is built on another thread, so building it (which
    /// asks sync for its status) never waits on the caller.
    pub fn sync_changed(self: &Arc<Self>) {
        self.sync_rt.changed();
        if self.sync_rt.status_pending.swap(true, Ordering::SeqCst) {
            return;
        }
        let core = Arc::clone(self);
        let spawned = thread::Builder::new()
            .name("sync-status".into())
            .spawn(move || {
                core.sync_rt.status_pending.store(false, Ordering::SeqCst);
                core.settings_changed();
            });
        if spawned.is_err() {
            self.sync_rt.status_pending.store(false, Ordering::SeqCst);
        }
    }

    /// Lets bucket sync look at the meetings now instead of at its next scan.
    fn nudge_sync(&self) {
        if let Some(sync) = &self.sync {
            sync.nudge();
        }
    }

    fn meeting_changed(&self) {
        self.meetings.publish_status();
        self.sink.tray(self.tray());
        self.settings.forget_storage();
        self.settings_changed();
    }

    pub fn shutdown(&self) {
        if self.shutting_down.swap(true, Ordering::SeqCst) {
            return;
        }
        // First, so an upload stops between requests while the rest shuts down (at most 2 s).
        if let Some(sync) = &self.sync {
            sync.shutdown();
        }
        self.media.shutdown();
        self.dictation.shutdown();
        self.meetings.shutdown();
        self.pill.update(|p, _| p.clear());
        self.pill.stop();
        // A meeting window that ignored its shutdown can still hold the local worker while the
        // model loads (up to 180 s) or a window transcribes. Quitting waits for it only so long:
        // Windows ends the worker with the app, because it runs in a kill-on-close job.
        let speech = Arc::clone(&self.svc.speech);
        let (stopped, wait) = mpsc::channel();
        let stopping = thread::Builder::new()
            .name("speech-shutdown".into())
            .spawn(move || {
                speech.shutdown();
                let _ = stopped.send(());
            });
        match stopping {
            Ok(_) => {
                let _ = wait.recv_timeout(SPEECH_SHUTDOWN_WAIT);
            }
            Err(_) => self.svc.speech.shutdown(),
        }
        self.svc.input.wait_for_clipboard_restore();
    }
}

/// How long quitting waits for the local model to stop. Longer than its own 2 s quit grace, so a
/// worker that is merely idle always gets to quit cleanly.
const SPEECH_SHUTDOWN_WAIT: Duration = Duration::from_secs(3);

/// How often the engine looks at meeting outcomes and at Rukoo's connection.
const WATCH_POLL: Duration = Duration::from_secs(1);
/// How often retention runs besides at start and after a meeting is done.
const SWEEP_EVERY: Duration = Duration::from_secs(10 * 60);
/// Held media is looked at again at most this often after bucket sync made progress.
const RESWEEP_AFTER: Duration = Duration::from_secs(5);
/// How often prepared media is swept and bucket sync's notifications are checked.
const MINUTE: Duration = Duration::from_secs(60);

/// The engine's slow loop. Shows a meeting whose transcription failed and lets a finished one
/// go (`meeting.state` `failed` and `done` come from the pipeline long after the recorder
/// stopped), keeps Settings > Rukoo current, runs the retention sweep, and lets prepared media go.
pub(crate) fn watch(core: Weak<Core>, mut seq: u64) {
    let mut swept = Instant::now();
    let mut minute = Instant::now();
    loop {
        thread::sleep(WATCH_POLL);
        let Some(core) = core.upgrade() else {
            return;
        };
        if core.shutting_down() {
            return;
        }
        core.rukoo_changed();
        if swept.elapsed() >= SWEEP_EVERY
            || (swept.elapsed() >= RESWEEP_AFTER && core.sync_rt.take_resweep())
        {
            swept = Instant::now();
            core.sweep();
        }
        if minute.elapsed() >= MINUTE {
            minute = Instant::now();
            core.media.sweep();
            crate::sync::check_failing(&core);
        }
        // Borrowed from the engine each round, so the log closes as soon as the engine is gone.
        let Some(log) = core.meetings.log.as_ref() else {
            return;
        };
        for stored in log.after(seq).unwrap_or_default() {
            seq = stored.seq;
            if stored.event != voice_protocol::events::MEETING_STATE {
                continue;
            }
            let Some(id) = stored.meeting.as_deref() else {
                continue;
            };
            let at = stored.data["at"].as_u64().unwrap_or(0);
            // A meeting can record while an earlier one still transcribes: these outcomes are
            // the earlier one's, and the pill keeps showing the one that records.
            match stored.data["state"].as_str() {
                Some("failed") => {
                    core.pill
                        .update(|p, now| p.meeting(id, MeetingPhase::Failed, at, now));
                    let reason = stored.data["reason"].as_str().unwrap_or_default();
                    core.notify(
                        crate::meetings::controller::NOTIFY_MEETING,
                        format!("Voice couldn't finish a meeting's transcript: {reason}. The audio is kept."),
                    );
                }
                Some("done") => {
                    core.pill.update(|p, _| p.meeting_gone(id));
                    // The transcript and the timeline can go up now.
                    if let Some(sync) = &core.sync {
                        sync.nudge();
                    }
                    // "After transcription" retention removes the audio now.
                    core.sweep();
                }
                _ => {}
            }
        }
    }
}

pub(crate) fn looks(opts: &EngineOptions, svc: &Services, cfg: &Config) -> Looks {
    Looks {
        edge: match cfg.pill_edge {
            core_config::PillEdge::Bottom => crate::api::Edge::Bottom,
            core_config::PillEdge::Top => crate::api::Edge::Top,
        },
        theme: match cfg.ui_theme {
            core_config::Theme::System => svc.system.theme(),
            core_config::Theme::Light => Theme::Light,
            core_config::Theme::Dark => Theme::Dark,
        },
        locale: match cfg.ui_language {
            core_config::UiLanguage::System => svc.system.locale(),
            core_config::UiLanguage::En => Locale::En,
            core_config::UiLanguage::Nl => Locale::Nl,
        },
        dev: opts.dev_mode,
    }
}

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

pub(crate) fn control_error(error: ControlError) -> ApiError {
    ApiError::new(error.code.as_str(), error.message)
}

/// The engine as the app holds it.
pub(crate) struct EngineImpl(pub Arc<Core>);

impl EngineApi for EngineImpl {
    fn pill_snapshot(&self) -> PillSnapshot {
        self.0.pill.read(|p| p.current())
    }

    fn pill_ack(&self, seq: u64) {
        self.0.pill.update(|p, _| p.ack(seq));
    }

    fn pill_stop_clicked(&self) {
        self.0.stop_clicked();
    }

    fn settings_state(&self) -> Value {
        crate::settings::state(&self.0)
    }

    fn settings_set(&self, key: &str, value: Value) -> Result<(), ApiError> {
        crate::settings::set(&self.0, key, value)
    }

    fn settings_save_provider(&self, save: Value) -> Result<(), ApiError> {
        crate::settings::save_provider(&self.0, save)
    }

    fn settings_remove_key(&self, target: &str) -> Result<(), ApiError> {
        crate::settings::remove_key(&self.0, target)
    }

    fn settings_list_models(&self, request: Value) -> Result<Vec<String>, ApiError> {
        crate::settings::list_models(&self.0, request)
    }

    fn settings_model(&self, model: &str, action: &str) -> Result<(), ApiError> {
        crate::settings::model(&self.0, model, action)
    }

    fn settings_set_folder(&self, purpose: &str, path: PathBuf) -> Result<(), ApiError> {
        crate::settings::set_folder(&self.0, purpose, path)
    }

    fn settings_clean_preview(&self, preview: Value) -> Result<String, ApiError> {
        crate::settings::clean_preview(&self.0, preview)
    }

    fn settings_check_updates(&self) -> Value {
        crate::settings::check_updates(&self.0)
    }

    fn settings_new_token(&self) -> Result<(), ApiError> {
        crate::settings::new_token(&self.0)
    }

    fn settings_import_ownkey(&self) -> Result<Value, ApiError> {
        crate::settings::import_ownkey(&self.0)
    }

    fn settings_sync_test(&self) -> Result<Value, ApiError> {
        crate::settings::sync_test(&self.0)
    }

    fn settings_sync_save_secret(&self, secret: String) -> Result<(), ApiError> {
        crate::settings::sync_save_secret(&self.0, secret)
    }

    fn settings_sync_key(&self, action: &str, code: Option<String>) -> Result<Value, ApiError> {
        crate::settings::sync_key(&self.0, action, code)
    }

    fn settings_sync_key_copy(&self) -> Result<(), ApiError> {
        crate::settings::sync_key_copy(&self.0)
    }

    fn settings_sync_restore(&self, action: &str) -> Result<Value, ApiError> {
        crate::settings::sync_restore(&self.0, action)
    }

    fn settings_start_page(&self) -> Option<String> {
        self.0.settings.take_start_page()
    }

    fn folder_path(&self, folder: Folder) -> Option<PathBuf> {
        crate::settings::folder_path(&self.0, folder)
    }

    fn start_meeting(&self) -> Result<String, ApiError> {
        self.0
            .meetings
            .controller
            .start(StartArgs::default(), StartedBy::Voice)
            .map_err(control_error)
    }

    fn stop_meeting(&self, reason: StopReason) -> Result<(), ApiError> {
        let reason = match reason {
            StopReason::User => "user",
            StopReason::Rukoo => "rukoo",
        };
        self.0
            .meetings
            .controller
            .stop(None, reason)
            .map_err(control_error)
    }

    fn pause_meeting(&self) -> Result<(), ApiError> {
        self.0
            .meetings
            .controller
            .pause(None)
            .map_err(control_error)
    }

    fn resume_meeting(&self) -> Result<(), ApiError> {
        self.0
            .meetings
            .controller
            .resume(None)
            .map_err(control_error)
    }

    fn ui(&self) -> UiOptions {
        let cfg = self.0.config();
        let looks = self.0.looks();
        UiOptions {
            theme: looks.theme,
            locale: looks.locale,
            pill_edge: looks.edge,
            hide_pill_from_capture: cfg.pill_hide_from_capture,
            dev: self.0.opts.dev_mode,
        }
    }

    fn tray_state(&self) -> TrayState {
        self.0.tray()
    }

    fn shutdown(&self) {
        self.0.shutdown();
    }

    fn meeting_control(&self) -> Option<Arc<dyn voice_bridge::MeetingControl>> {
        self.0
            .meetings
            .control()
            .map(|control| control as Arc<dyn voice_bridge::MeetingControl>)
    }
}

impl Drop for EngineImpl {
    fn drop(&mut self) {
        // Threads hold only weak references; this ends them if the app forgot to shut down.
        self.0.shutdown();
    }
}

/// The recognizer for a meeting provider that can't be built (a missing key or model): every
/// window fails with the reason, which `meeting.state` `failed` carries if it never changes.
struct Unavailable(ProviderError);

impl SpeechToText for Unavailable {
    fn transcribe(&self, _pcm: &[i16], _hints: &Hints) -> Result<Recognized, ProviderError> {
        Err(self.0.clone())
    }
}
