//! Rukoo Voice's behavior behind one API: dictation, the pill's state, Settings and meetings.
//!
//! The Tauri app (`voice-app`) drives it through [`api::EngineApi`] and renders what comes out of
//! [`api::UiSink`]. Nothing in this crate opens a window, so all of it can be tested without one.

pub mod api;
pub mod autostart;
mod dictation;
mod engine;
pub mod meetings;
mod pill;
mod platform;
pub mod services;
mod settings;

use std::fs;
use std::sync::{Arc, OnceLock, Weak};

use voice_bridge::EventLog;
use voice_core::config::{Config, ConfigError};
use voice_protocol::paths::{bridge_path, Platform};
use voice_protocol::Side;

pub use api::{
    Activity, ApiError, Edge, Engine, EngineApi, EngineOptions, Folder, Locale, MeetingPill,
    Notice, Notification, PillPhase, PillRepair, PillSnapshot, StopReason, Theme, TrayState,
    UiOptions, UiSink,
};
pub use services::Services;

use crate::dictation::Dictation;
use crate::engine::{Core, EngineImpl};
use crate::meetings::controller::{self, Controller, ControllerOptions};
use crate::meetings::Meetings;
use crate::settings::SettingsRuntime;

/// Notification titles the engine uses besides dictation's (voice/ui/i18n `app.notify.*`).
pub const NOTIFY_SETTINGS: &str = "app.notify.settings";
pub const NOTIFY_WELCOME: &str = "app.notify.welcome";

/// Every notification title the engine sends; voice-app checks that both catalogs have them.
pub const NOTIFY_TITLES: &[&str] = &[
    dictation::errors::TITLE_DICTATION,
    dictation::errors::TITLE_REWRITE,
    dictation::errors::TITLE_NO_TEXT_BOX,
    meetings::controller::NOTIFY_MEETING,
    NOTIFY_SETTINGS,
    NOTIFY_WELCOME,
];

/// Starts Voice: loads Settings (running the first-run Ownkey import when it applies), starts the
/// hotkeys, reattaches to a recorder that is still recording, finishes meetings that were cut off,
/// and opens the bridge for Rukoo. Output goes to `sink` from here on.
pub fn start(options: EngineOptions, sink: Arc<dyn UiSink>) -> Result<Engine, ApiError> {
    let services = Services::system(&options);
    start_with(options, sink, services)
}

/// [`start`] on other services: tests run the engine on fakes this way.
pub fn start_with(
    options: EngineOptions,
    sink: Arc<dyn UiSink>,
    services: Services,
) -> Result<Engine, ApiError> {
    let data_dir = options.data_dir.clone();
    let dev_mode = options.dev_mode;
    fs::create_dir_all(&data_dir).map_err(|e| {
        ApiError::new(
            "failed",
            format!(
                "Voice couldn't make its data folder {}: {e}",
                data_dir.display()
            ),
        )
    })?;
    let first_run = Config::is_first_run(&data_dir);
    let mut notices: Vec<(&str, String)> = Vec::new();
    let mut cfg = match Config::load_as(&data_dir, dev_mode) {
        Ok(cfg) => cfg,
        Err(damaged @ ConfigError::Damaged { .. }) => {
            notices.push((NOTIFY_SETTINGS, damaged.to_string()));
            Config::defaults(dev_mode)
        }
        Err(e) => return Err(ApiError::new("config", e.to_string())),
    };
    let mut save = first_run;
    if first_run {
        // Voice transcribes on this computer unless the user picks a provider (voice/ui/API.md).
        cfg.switch_audio_provider("orukeet");
    }

    // The import: automatic on an installed copy's first start, and on request with
    // --import-ownkey <copy>, the only way a development copy imports.
    let mut start_page = None;
    let source = match &options.import_ownkey_from {
        Some(path) => Some(path.clone()),
        None if first_run && !dev_mode => services.ownkey_config.clone().filter(|p| p.is_file()),
        None => None,
    };
    if let Some(path) = source {
        match settings::ownkey::read(&path) {
            Ok((result, raw)) => {
                let report = settings::ownkey::apply(&result, &raw, &mut cfg, dev_mode);
                settings::ownkey::save_report(&data_dir, &report);
                start_page = Some("import".to_string());
                save = true;
            }
            Err(e) if options.import_ownkey_from.is_some() => {
                notices.push((
                    NOTIFY_SETTINGS,
                    format!("Ownkey's settings weren't imported: {}", e.message),
                ));
            }
            Err(_) => {}
        }
    }
    save |= cfg.resolve_same_meeting_provider();
    if save {
        cfg.save(&data_dir)
            .map_err(|e| ApiError::new("config", format!("Voice couldn't save Settings: {e}")))?;
    }
    // Decision 6: an installed copy starts at login from its first start; never re-enabled later.
    if first_run && !dev_mode {
        let _ = services.autostart.set(true);
    }

    let sources = match options.test_sources.as_deref().filter(|_| dev_mode) {
        Some(text) => controller::parse_sources(text).unwrap_or_else(|e| {
            notices.push((
                NOTIFY_SETTINGS,
                format!("RUKOO_VOICE_TEST_SOURCES was ignored: {e}"),
            ));
            controller::default_sources()
        }),
        None => controller::default_sources(),
    };
    let log = EventLog::open(&data_dir).ok();
    let discovery = services.discovery_path.clone().or_else(|| {
        let data = data_dir.display().to_string();
        let env = move |name: &str| {
            if name == voice_core::paths::DATA_DIR_ENV {
                Some(data.clone())
            } else {
                std::env::var(name).ok()
            }
        };
        bridge_path(Side::Voice, Platform::current(), &env).map(Into::into)
    });

    // The controller reports to the engine, which doesn't exist yet: it gets the engine once
    // it does. Nothing records before `recover` below, so no report is lost.
    let engine: Arc<OnceLock<Weak<Core>>> = Arc::new(OnceLock::new());
    let controller = Controller::new(
        ControllerOptions {
            data_dir: data_dir.clone(),
            recorder_exe: services.recorder_exe.clone(),
            sources,
            timing: services.controller.clone(),
        },
        {
            let engine = Arc::clone(&engine);
            move |change| {
                if let Some(core) = engine.get().and_then(Weak::upgrade) {
                    core.on_meeting(change);
                }
            }
        },
    )
    .map_err(|e| {
        ApiError::new(
            "failed",
            format!("Voice couldn't open its meetings folder: {e}"),
        )
    })?;
    // Before the bridge opens, so a meeting Rukoo starts at once keeps it too.
    controller.library().set_retention(cfg.meetings_retention);
    let meetings = Meetings::new(controller, log, discovery, &options.version);
    let core = Arc::new(Core::new(
        options,
        services,
        sink,
        cfg,
        meetings,
        SettingsRuntime::new(start_page),
    ));
    let _ = engine.set(Arc::downgrade(&core));
    core.set_this();

    let cfg = core.config();
    core.svc
        .speech
        .local_configure(core.registry(&cfg), cfg.idle_timeout());
    if let Err(e) = Dictation::start(&core) {
        notices.push((
            dictation::errors::TITLE_DICTATION,
            format!("Keyboard setup is incomplete. {e}"),
        ));
    }
    // Reattaches to a recorder that still records and finalizes meetings that were cut off;
    // both start a pipeline. Then meetings whose transcription didn't finish get one too.
    core.meetings.controller.recover();
    for id in core.meetings.unfinished() {
        core.follow(&id);
    }
    core.sweep();
    core.meetings.publish_status();
    if let Some(head) = core.meetings.log.as_ref().map(|log| log.head()) {
        let weak = Arc::downgrade(&core);
        let _ = std::thread::Builder::new()
            .name("engine-watch".into())
            .spawn(move || engine::watch(weak, head));
    }
    let weak = Arc::downgrade(&core);
    let _ = std::thread::Builder::new()
        .name("update-check".into())
        .spawn(move || settings::schedule_updates(weak));
    if first_run {
        let status = settings::state(&core)["dictation"]["status"].clone();
        if status == "modelMissing" || status == "noKey" {
            notices.push((
                NOTIFY_WELCOME,
                "Welcome to Rukoo Voice. Open Settings > Transcription to choose how your voice becomes text.".into(),
            ));
        }
    }
    for (title, body) in notices {
        core.notify(title, body);
    }
    core.sink.tray(core.tray());
    core.settings_changed();
    Ok(Arc::new(EngineImpl(core)))
}
