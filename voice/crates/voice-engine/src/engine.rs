//! The engine's shared state and the [`EngineApi`] the app drives.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard, OnceLock, PoisonError, RwLock, Weak};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Map, Value};
use voice_bridge::ControlError;
use voice_core::config::{self as core_config, Config};
use voice_core::local::ModelRegistry;
use voice_core::{Hints, ProviderError, Recognized, SpeechToText};
use voice_input::Key;
use voice_protocol::{ScreenMode, StartArgs, StartedBy};
use voice_screen_files::policy::{Part, Reason};

use crate::api::{
    ApiError, EngineApi, EngineOptions, Folder, Locale, Notification, PillSnapshot, StopReason,
    Theme, TrayState, UiOptions, UiSink,
};
use crate::dictation::Dictation;
use crate::meetings::controller::{Change, NOTIFY_MEETING};
use crate::meetings::screen::ScreenChange;
use crate::meetings::{Meetings, PipelineOptions};
use crate::pill::{notices, Looks, MeetingPhase, PillDriver, DROP_HOLD, MOVED_HOLD};
use crate::platform::CHIME_COOLDOWN;
use crate::services::Services;
use crate::settings::SettingsRuntime;

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

impl Core {
    pub fn new(
        opts: EngineOptions,
        svc: Services,
        sink: Arc<dyn UiSink>,
        config: Config,
        meetings: Meetings,
        settings: SettingsRuntime,
    ) -> Core {
        let looks = looks(&opts, &svc, &config);
        Core {
            pill: PillDriver::new(looks, Arc::clone(&sink)),
            dictation: Dictation::new(&config, opts.dev_mode),
            config: RwLock::new(Arc::new(config)),
            writing: Mutex::new(()),
            settings,
            meetings,
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
        // So does the screen; Rukoo learns the new default from the next status.
        if old.meetings_screen != new.meetings_screen {
            self.meetings
                .controller
                .set_screen(screen_mode(new), self.meetings.screen.available());
            self.meetings.publish_status();
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
                // The recorder runs; the screen process follows on its own thread, after the
                // start handshake for a meeting Voice started.
                self.meetings.screen.begin(&id);
                self.pill_screen(&id);
                self.follow(&id);
                self.meeting_changed();
            }
            Change::Reattached { id, paused, at_ms } => {
                let phase = if paused {
                    MeetingPhase::Paused
                } else {
                    MeetingPhase::Recording
                };
                self.pill.update(|p, now| p.meeting(&id, phase, at_ms, now));
                self.meetings.screen.reattach(&id);
                self.pill_screen(&id);
                self.follow(&id);
                self.meeting_changed();
            }
            Change::Paused { id, at_ms } => {
                self.pill
                    .update(|p, now| p.meeting(&id, MeetingPhase::Paused, at_ms, now));
                self.screen_paused(&id, true);
                self.meeting_changed();
            }
            Change::Resumed { id, at_ms } => {
                self.pill
                    .update(|p, now| p.meeting(&id, MeetingPhase::Recording, at_ms, now));
                self.screen_paused(&id, false);
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
                // The screen process stops at the timeline's stop; waiting for it takes up to
                // 15 s, so it happens off this thread.
                let screen = Arc::clone(&self.meetings.screen);
                let ended = id.clone();
                let _ = thread::Builder::new()
                    .name("screen-end".into())
                    .spawn(move || screen.end(&ended));
                self.meeting_changed();
            }
            Change::Finalized { id } => {
                // Cut off while Voice wasn't running: what was recorded still gets transcribed.
                // `ScreenSupervisor::recover`, right after the controller's, gives its screen
                // journal the `stop` it lacks.
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

    /// Forwards a pause or resume to the screen process, off the event thread.
    fn screen_paused(&self, id: &str, paused: bool) {
        let screen = Arc::clone(&self.meetings.screen);
        let id = id.to_string();
        let _ = thread::Builder::new()
            .name("screen-pause".into())
            .spawn(move || screen.pause(&id, paused));
    }

    /// What the pill shows of the meeting's screen recording.
    fn pill_screen(&self, id: &str) {
        let (mode, switch) = self.meetings.screen.pill_state(id);
        let current = self.meetings.controller.current().map(|r| r.id);
        if current.as_deref() == Some(id) {
            self.pill
                .update(|p, _| p.meeting_screen(mode.as_str(), switch));
        }
    }

    /// What the screen supervisor reports: drops and give-ups become pill notices and tray
    /// notifications, a move shows the monitor's name.
    pub fn on_screen(self: &Arc<Self>, change: ScreenChange) {
        match change {
            ScreenChange::Dropped { id, what, reason } => {
                self.screen_notice(&id, Some(drop_notice(what, reason)), Map::new(), DROP_HOLD);
                if let Some(body) = drop_text(what, reason) {
                    self.notify(NOTIFY_MEETING, body.to_string());
                }
                self.pill_screen(&id);
            }
            ScreenChange::GaveUp { id } => {
                self.screen_notice(&id, Some(notices::SCREEN_FAILED), Map::new(), DROP_HOLD);
                self.notify(
                    NOTIFY_MEETING,
                    "Voice's screen recorder stopped 5 times in a row, so the screen isn't recorded any more. The audio goes on.".to_string(),
                );
                self.pill_screen(&id);
            }
            ScreenChange::Moved { id, name } => {
                let mut args = Map::new();
                args.insert("name".into(), Value::String(name));
                self.screen_notice(&id, Some(notices::SCREEN_MOVED), args, MOVED_HOLD);
            }
            ScreenChange::Monitors { .. } => {
                // The probe answered or a monitor came or went: Settings shows it, a computer
                // that can't capture starts meetings with `off`, and the pill's screen button
                // shows when there is another monitor.
                let cfg = self.config();
                self.meetings
                    .controller
                    .set_screen(screen_mode(&cfg), self.meetings.screen.available());
                if let Some(id) = self.meetings.controller.current().map(|r| r.id) {
                    self.pill_screen(&id);
                }
                self.meetings.publish_status();
                self.settings_changed();
            }
        }
    }

    /// A pill notice about the meeting that records now.
    fn screen_notice(&self, id: &str, key: Option<&str>, args: Map<String, Value>, hold: Duration) {
        let Some(key) = key else {
            return;
        };
        if self.meetings.controller.current().map(|r| r.id).as_deref() != Some(id) {
            return;
        }
        self.pill
            .update(|p, now| p.meeting_notice(key, args, hold, now));
    }

    /// The pill's screen button: the screen recording moves to the next monitor.
    pub fn screen_clicked(self: &Arc<Self>) {
        // Talks to the screen process; the click comes from the app's window thread.
        let screen = Arc::clone(&self.meetings.screen);
        let _ = thread::Builder::new()
            .name("screen-next".into())
            .spawn(move || {
                if let Err(e) = screen.next_monitor() {
                    log::info!("screen: the pill's switch did nothing: {e}");
                }
            });
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
    pub fn sweep(&self) {
        let removed = self.meetings.sweep(self.config().meetings_retention);
        // Clips are copies made on request, kept an hour after their last use.
        let clips = voice_screen_files::media::sweep_clips(
            self.meetings.library().root(),
            now_ms(),
            CLIP_LIFETIME_MS,
        );
        if !removed.is_empty() {
            log::info!("retention: removed the media of {}", removed.join(", "));
        }
        if !removed.is_empty() || clips > 0 {
            self.settings.forget_storage();
            self.settings_changed();
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

/// How long a clip `clip.get` cut stays after its last use.
const CLIP_LIFETIME_MS: u64 = 3_600_000;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// Settings > Meetings > Screen as the protocol names it.
pub(crate) fn screen_mode(cfg: &Config) -> ScreenMode {
    match cfg.meetings_screen {
        core_config::ScreenMode::Off => ScreenMode::Off,
        core_config::ScreenMode::Frames => ScreenMode::Frames,
        core_config::ScreenMode::Video => ScreenMode::Video,
    }
}

/// The pill notice for a part of the screen recording that stopped.
fn drop_notice(what: Part, reason: Reason) -> &'static str {
    match (what, reason) {
        (Part::Video, Reason::Disk) => notices::VIDEO_DROPPED_DISK,
        (Part::Video, Reason::Encoder) => notices::VIDEO_DROPPED_ENCODER,
        (Part::Video, Reason::Device) => notices::VIDEO_DROPPED_DEVICE,
        (Part::Frames, Reason::Disk) => notices::FRAMES_DROPPED_DISK,
        (Part::Frames, _) => notices::SCREEN_FAILED,
    }
}

/// The tray notification for a part of the screen recording that stopped.
fn drop_text(what: Part, reason: Reason) -> Option<&'static str> {
    Some(match (what, reason) {
        (Part::Video, Reason::Disk) => "Voice stopped the screen video to keep recording audio: the disk is almost full. Frames go on.",
        (Part::Video, Reason::Encoder) => "Voice records the screen as frames only: no video encoder on this computer worked.",
        // The frames go on with a device without video support. When no device came back at
        // all, the frames stop right after and their notification says so.
        (Part::Video, Reason::Device) => "Voice stopped the screen video: the graphics device didn't come back with video support.",
        (Part::Frames, Reason::Disk) => "Voice stopped recording the screen to keep recording audio: the disk is almost full.",
        (Part::Frames, Reason::Device) => "Voice stopped recording the screen: the graphics device couldn't be started again. The audio goes on.",
        (Part::Frames, Reason::Encoder) => return None,
    })
}

/// How long quitting waits for the local model to stop. Longer than its own 2 s quit grace, so a
/// worker that is merely idle always gets to quit cleanly.
const SPEECH_SHUTDOWN_WAIT: Duration = Duration::from_secs(3);

/// How often the engine looks at meeting outcomes and at Rukoo's connection.
const WATCH_POLL: Duration = Duration::from_secs(1);
/// How often retention runs besides at start and after a meeting is done.
const SWEEP_EVERY: Duration = Duration::from_secs(10 * 60);

/// The engine's slow loop. Shows a meeting whose transcription failed and lets a finished one
/// go (`meeting.state` `failed` and `done` come from the pipeline long after the recorder
/// stopped), keeps Settings > Rukoo current, and runs the retention sweep.
pub(crate) fn watch(core: Weak<Core>, mut seq: u64) {
    let mut swept = Instant::now();
    loop {
        thread::sleep(WATCH_POLL);
        let Some(core) = core.upgrade() else {
            return;
        };
        if core.shutting_down() {
            return;
        }
        core.rukoo_changed();
        if swept.elapsed() >= SWEEP_EVERY {
            swept = Instant::now();
            core.sweep();
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

    fn pill_screen_clicked(&self) {
        self.0.screen_clicked();
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

#[cfg(test)]
mod drop_tests {
    use super::*;

    /// Every drop the screen process can journal reaches the pill, and every one but a frames
    /// drop for the encoder, which never happens, the tray.
    #[test]
    fn every_drop_has_a_notice_and_a_notification() {
        assert_eq!(
            drop_notice(Part::Video, Reason::Disk),
            "pill.videoDropped.disk"
        );
        assert_eq!(
            drop_notice(Part::Video, Reason::Encoder),
            "pill.videoDropped.encoder"
        );
        assert_eq!(
            drop_notice(Part::Video, Reason::Device),
            "pill.videoDropped.device"
        );
        assert_eq!(
            drop_notice(Part::Frames, Reason::Disk),
            "pill.framesDropped.disk"
        );
        assert_eq!(
            drop_notice(Part::Frames, Reason::Device),
            "pill.screenFailed"
        );
        assert!(drop_text(Part::Video, Reason::Encoder)
            .unwrap()
            .contains("frames only"));
        assert!(drop_text(Part::Video, Reason::Device)
            .unwrap()
            .contains("video support"));
        assert!(drop_text(Part::Video, Reason::Disk)
            .unwrap()
            .contains("Frames go on"));
        assert!(drop_text(Part::Frames, Reason::Device).is_some());
        assert!(drop_text(Part::Frames, Reason::Disk).is_some());
    }
}
