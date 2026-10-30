//! Ownkey's push-to-talk regression tests from fix #11
//! (`tests/test_windows_hotkeys.py`, `PushToTalkTests` and
//! `SettingsRestartTests`), driven through the poller with an injected
//! keyboard and a fake microphone that is slow to open or close.

mod common;

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use common::{wait_for, Keyboard, Latch, INTERVAL};
use voice_input::{Action, HotkeyConfig, HotkeyEvent, HotkeyPoller, Key, Mode, PushToTalk};

/// The dictation side of the app, as far as the hotkeys see it.
struct App {
    ptt: Mutex<PushToTalk>,
    started: Mutex<Vec<Mode>>,
    stops: AtomicUsize,
    /// Recordings handed to the transcription queue.
    queued: Mutex<Vec<Mode>>,
    opening: Latch,
    closing: Latch,
    mic_fails: AtomicBool,
}

impl App {
    fn handle(&self, event: HotkeyEvent) {
        // The lock is never held while the microphone opens or closes.
        let action = self.ptt.lock().unwrap().handle(event);
        match action {
            Some(Action::Start(mode)) => {
                self.started.lock().unwrap().push(mode);
                if self.mic_fails.load(Ordering::SeqCst) {
                    self.ptt.lock().unwrap().recording_ended();
                    return;
                }
                self.opening.wait(); // the microphone is slow to open
            }
            Some(Action::Stop) => {
                self.closing.wait(); // the microphone is slow to close
                let mode = self.ptt.lock().unwrap().mode();
                self.queued.lock().unwrap().push(mode);
                self.stops.fetch_add(1, Ordering::SeqCst);
            }
            None => {}
        }
    }

    fn started(&self) -> Vec<Mode> {
        self.started.lock().unwrap().clone()
    }

    fn stops(&self) -> usize {
        self.stops.load(Ordering::SeqCst)
    }

    fn is_down(&self) -> bool {
        self.ptt.lock().unwrap().is_down()
    }

    fn is_recording(&self) -> bool {
        self.ptt.lock().unwrap().is_recording()
    }
}

struct Setup {
    app: Arc<App>,
    keyboard: Arc<Keyboard>,
    poller: HotkeyPoller,
}

/// Polls every offered key, as the app does.
fn setup(config: HotkeyConfig, slow_open: bool, slow_close: bool) -> Setup {
    let app = Arc::new(App {
        ptt: Mutex::new(PushToTalk::new(config)),
        started: Mutex::new(Vec::new()),
        stops: AtomicUsize::new(0),
        queued: Mutex::new(Vec::new()),
        opening: Latch::new(!slow_open),
        closing: Latch::new(!slow_close),
        mic_fails: AtomicBool::new(false),
    });
    let keyboard = Keyboard::new(Key::ALL.len(), &[]);
    let poller = HotkeyPoller::spawn_handler_with(Key::ALL.to_vec(), keyboard.state(), INTERVAL, {
        let app = Arc::clone(&app);
        move |event| app.handle(event)
    })
    .unwrap();
    Setup {
        app,
        keyboard,
        poller,
    }
}

const ALT_AND_SHIFT: HotkeyConfig = HotkeyConfig {
    dictate: Key::RightAlt,
    rewrite: Some(Key::RightShift),
};

const OWNKEY_DEFAULTS: HotkeyConfig = HotkeyConfig {
    dictate: Key::RightAlt,
    rewrite: Some(Key::RightCtrl),
};

/// Ownkey #11 test 4 (`:167`).
#[test]
fn a_quick_tap_during_a_slow_start_stops_the_recording() {
    let Setup {
        app,
        keyboard,
        poller,
    } = setup(ALT_AND_SHIFT, true, false);
    keyboard.set(Key::RightAlt, true);
    assert!(wait_for(|| app.started() == [Mode::Dictate]));
    keyboard.set(Key::RightAlt, false);
    app.opening.open();
    assert!(wait_for(|| app.stops() == 1));
    assert!(!app.is_down());
    assert!(!app.is_recording());
    poller.join();
}

/// Ownkey #11 test 5 (`:176`): a capital letter typed with Right Shift used
/// to leave dictation dead.
#[test]
fn dictation_works_after_a_quick_rewrite_tap() {
    let Setup {
        app,
        keyboard,
        poller,
    } = setup(ALT_AND_SHIFT, true, false);
    keyboard.set(Key::RightShift, true);
    assert!(wait_for(|| app.started() == [Mode::Rewrite]));
    keyboard.set(Key::RightShift, false);
    app.opening.open();
    assert!(wait_for(|| app.stops() == 1));
    keyboard.set(Key::RightAlt, true);
    assert!(wait_for(|| app.started() == [Mode::Rewrite, Mode::Dictate]));
    keyboard.set(Key::RightAlt, false);
    assert!(wait_for(|| app.stops() == 2));
    assert!(!app.is_down());
    poller.join();
}

/// Ownkey #11 test 6 (`:189`).
#[test]
fn a_second_hold_during_a_slow_start_is_a_separate_recording() {
    let Setup {
        app,
        keyboard,
        poller,
    } = setup(ALT_AND_SHIFT, true, false);
    keyboard.set(Key::RightAlt, true);
    assert!(wait_for(|| app.started() == [Mode::Dictate]));
    keyboard.set(Key::RightAlt, false);
    keyboard.set(Key::RightAlt, true);
    app.opening.open();
    assert!(wait_for(|| app.started() == [Mode::Dictate, Mode::Dictate]));
    assert_eq!(app.stops(), 1);
    assert!(app.is_recording());
    keyboard.set(Key::RightAlt, false);
    assert!(wait_for(|| app.stops() == 2));
    assert!(!app.is_down());
    assert!(!app.is_recording());
    poller.join();
}

/// Ownkey #11 test 7 (`:243`): Settings saved during a recording, then a
/// release, a press and a release while the microphone is slow to close.
#[test]
fn a_hold_during_a_slow_close_survives_a_settings_change() {
    let Setup {
        app,
        keyboard,
        poller,
    } = setup(OWNKEY_DEFAULTS, false, true);
    keyboard.set(Key::RightAlt, true);
    assert!(wait_for(|| app.is_recording()));
    let saved = HotkeyConfig {
        dictate: Key::RightAlt,
        rewrite: Some(Key::F14),
    };
    app.ptt.lock().unwrap().set_config(saved);
    keyboard.set(Key::RightAlt, false);
    keyboard.set(Key::RightAlt, true);
    keyboard.set(Key::RightAlt, false);
    app.closing.open();
    assert!(wait_for(|| app.queued.lock().unwrap().len() == 2));
    assert!(poller.is_running(), "the same poller keeps running");
    assert!(!app.is_down());
    assert!(!app.is_recording());
    assert_eq!(app.ptt.lock().unwrap().config(), saved);
    poller.join();
}

/// Ownkey #11 test 8 (`:257`): the rewrite key is held but the microphone
/// didn't open, then Settings turns the rewrite key off.
#[test]
fn turning_off_a_held_rewrite_key_after_a_failed_start_keeps_dictation_working() {
    let Setup {
        app,
        keyboard,
        poller,
    } = setup(ALT_AND_SHIFT, false, false);
    app.mic_fails.store(true, Ordering::SeqCst);
    keyboard.set(Key::RightShift, true);
    assert!(wait_for(
        || app.started() == [Mode::Rewrite] && !app.is_recording()
    ));
    assert_eq!(app.ptt.lock().unwrap().mode(), Mode::Rewrite);
    app.ptt.lock().unwrap().set_config(HotkeyConfig {
        dictate: Key::RightAlt,
        rewrite: None,
    });
    keyboard.set(Key::RightShift, false);
    app.mic_fails.store(false, Ordering::SeqCst);
    keyboard.set(Key::RightAlt, true);
    assert!(wait_for(|| app.is_recording()));
    assert_eq!(app.ptt.lock().unwrap().mode(), Mode::Dictate);
    assert!(poller.is_running(), "the same poller keeps running");
    poller.join();
}
