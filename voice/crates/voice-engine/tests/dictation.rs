//! Dictation through the whole engine, on fakes: the key state is injected, the microphone,
//! speech providers and text insertion are fakes, and nothing reaches the real desktop.

mod support;

use std::sync::atomic::Ordering;
use std::time::Duration;

use serde_json::json;
use support::{lock, tone, wait_for, Harness, MicPlan};
use voice_core::{ErrorKind, ProviderError};
use voice_engine::PillPhase;
use voice_input::{InputError, InsertMode, Key, TextTarget};

#[test]
fn a_dictation_is_transcribed_cleaned_and_inserted() {
    let h = Harness::new("dictate");
    h.config(json!({"ready_chime": true}));
    let engine = h.start();
    h.speech.say("Um, hello uh world.");
    h.hold(Key::F13);
    let inserted = h.sink.wait_phase(PillPhase::Inserted);
    assert_eq!(inserted.words, Some(2));
    assert_eq!(h.input.texts(), ["Hello world."]);
    assert_eq!(lock(&h.input.inserted)[0].mode, InsertMode::Paste);
    let phases = h.sink.phases();
    let expected = [
        PillPhase::Arming,
        PillPhase::Listening,
        PillPhase::Transcribing,
        PillPhase::Inserted,
    ];
    let mut at = 0;
    for phase in &phases {
        if at < expected.len() && *phase == expected[at] {
            at += 1;
        }
    }
    assert_eq!(at, expected.len(), "phases in order: {phases:?}");
    assert!(
        h.sink.levels.load(Ordering::SeqCst) > 0,
        "the level meter ran"
    );
    assert_eq!(
        h.chime.0.load(Ordering::SeqCst),
        1,
        "one chime at the first buffer"
    );
    assert!(h.speech.heard()[0] >= 3200, "the whole recording was sent");
    assert!(engine.pill_snapshot().dev, "a development pill says so");
    // The check stays for 700 ms, then the pill hides.
    h.sink.wait_hidden_after(PillPhase::Inserted);
    engine.shutdown();
}

#[test]
fn typing_mode_and_a_second_dictation_work_the_same_way() {
    let h = Harness::new("type");
    h.config(json!({"paste_mode": false}));
    let engine = h.start();
    h.speech.say("first");
    h.hold(Key::F13);
    wait_for("the first insertion", || h.input.texts().len() == 1);
    h.speech.say("second");
    h.hold(Key::F13);
    wait_for("the second insertion", || h.input.texts().len() == 2);
    assert_eq!(h.input.texts(), ["first", "second"]);
    assert!(lock(&h.input.inserted)
        .iter()
        .all(|i| i.mode == InsertMode::Type));
    engine.shutdown();
}

#[test]
fn a_spoken_edit_rewrites_the_selection() {
    let h = Harness::new("rewrite");
    h.config(json!({"rewrite_api_key": "k"}));
    *lock(&h.input.selection) = Some("teh draft".into());
    lock(&h.speech.rewrites).push_back(Ok("The draft.".into()));
    let engine = h.start();
    h.speech.say("fix the spelling");
    h.hold(Key::F14);
    h.sink.wait_phase(PillPhase::Rewrote);
    assert_eq!(h.input.texts(), ["The draft."]);
    let requests = lock(&h.speech.rewrite_requests).clone();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].user,
        "Instruction: fix the spelling\n\nText:\nteh draft"
    );
    assert!(requests[0]
        .system
        .starts_with("You edit text according to a spoken instruction."));
    // F14 can be held while Ctrl+C is sent, so the selection was copied at the press.
    assert_eq!(h.input.captures.load(Ordering::SeqCst), 1);
    assert!(h
        .sink
        .phases()
        .iter()
        .all(|p| *p != PillPhase::Transcribing));
    engine.shutdown();
}

#[test]
fn right_shift_copies_the_selection_only_after_the_release() {
    let mut h = Harness::new("rewrite-shift");
    h.dev_mode = false;
    // An installed copy whose rewrite key is Right Shift, which changes Ctrl+C while held.
    h.config(
        json!({"hotkey": "right ctrl", "rewrite_hotkey": "right shift", "rewrite_api_key": "k"}),
    );
    *lock(&h.input.selection) = Some("selected".into());
    let engine = h.start();
    h.speech.say("shorter");
    h.keys.down(Key::RightShift);
    wait_for("the microphone", || {
        h.mic.delivered.load(Ordering::SeqCst) >= 3200
    });
    assert_eq!(
        h.input.captures.load(Ordering::SeqCst),
        0,
        "Ctrl+C with Right Shift held would be Ctrl+Shift+C"
    );
    h.keys.up(Key::RightShift);
    h.sink.wait_phase(PillPhase::Rewrote);
    assert_eq!(h.input.captures.load(Ordering::SeqCst), 1);
    engine.shutdown();
}

#[test]
fn auto_rewrite_polishes_and_falls_back_to_the_transcript() {
    let h = Harness::new("auto-rewrite");
    h.config(json!({"auto_rewrite": true, "rewrite_api_key": "k"}));
    lock(&h.speech.rewrites).push_back(Ok("Hello there, Anna.".into()));
    lock(&h.speech.rewrites).push_back(Err(ProviderError::new(
        ErrorKind::Network,
        "Couldn't reach api.mistral.ai. Check your internet connection.",
    )));
    let engine = h.start();
    h.speech.say("hello there anna");
    h.hold(Key::F13);
    wait_for("the polished text", || h.input.texts().len() == 1);
    assert!(h.sink.phases().contains(&PillPhase::Rewriting));
    h.speech.say("second try");
    h.hold(Key::F13);
    wait_for("the raw text", || h.input.texts().len() == 2);
    assert_eq!(h.input.texts(), ["Hello there, Anna.", "second try"]);
    let note = h.sink.wait_note("app.notify.rewriteFailed");
    assert_eq!(
        note.body,
        "Rewrite failed. Inserted the raw transcript instead."
    );
    // The rewrite asked for Ownkey's dictation prompt with the cleaned transcript.
    let requests = lock(&h.speech.rewrite_requests).clone();
    assert!(requests[0]
        .system
        .starts_with("Turn raw dictation into clear, natural written text."));
    assert_eq!(requests[0].user, "hello there anna");
    engine.shutdown();
}

#[test]
fn an_empty_capture_shows_nothing_heard_and_calls_no_provider() {
    let h = Harness::new("empty");
    h.config(json!({}));
    // Silence: never heard, and well under 0.10 s.
    lock(&h.mic.plans).push_back(tone(5, 0.0));
    let engine = h.start();
    h.keys.down(Key::F13);
    wait_for("the silence", || {
        h.mic.delivered.load(Ordering::SeqCst) >= 800
    });
    h.keys.up(Key::F13);
    h.sink.wait_phase(PillPhase::NothingHeard);
    assert!(h.speech.heard().is_empty());
    assert!(h.input.texts().is_empty());
    h.sink.wait_hidden_after(PillPhase::NothingHeard);
    engine.shutdown();
}

#[test]
fn an_empty_transcript_also_shows_nothing_heard() {
    let h = Harness::new("empty-text");
    h.config(json!({}));
    let engine = h.start();
    h.speech.say("  um  ");
    h.hold(Key::F13);
    h.sink.wait_phase(PillPhase::NothingHeard);
    assert!(h.input.texts().is_empty(), "a filler alone inserts nothing");
    engine.shutdown();
}

fn last_error(h: &Harness) -> String {
    h.sink.wait_phase(PillPhase::Error).notice.unwrap().key
}

#[test]
fn provider_failures_become_pill_notices_and_notifications() {
    let h = Harness::new("errors");
    h.config(json!({}));
    let engine = h.start();
    for (error, notice, body) in [
        (
            ProviderError::new(ErrorKind::Auth, "API error 401: Invalid API key"),
            "pill.error.auth",
            "Transcription failed: API error 401: Invalid API key",
        ),
        (
            ProviderError::new(
                ErrorKind::Network,
                "Couldn't reach api.openai.com. Check your internet connection.",
            ),
            "pill.error.offline",
            "Couldn't reach api.openai.com. Check your internet connection.",
        ),
        (
            ProviderError::new(
                ErrorKind::Timeout,
                "OpenAI didn't answer within 30 seconds. Try again.",
            ),
            "pill.error.timeout",
            "OpenAI didn't answer within 30 seconds. Try again.",
        ),
        (
            ProviderError::new(
                ErrorKind::LocalMissingModel,
                "Model missing. Download it in Settings > Transcription.",
            ),
            "pill.error.modelMissing",
            "Transcription failed: Model missing. Download it in Settings > Transcription.",
        ),
        (
            ProviderError::new(ErrorKind::Provider, "API error 500: oops"),
            "pill.error.generic",
            "Transcription failed: API error 500: oops",
        ),
    ] {
        lock(&h.sink.pills).clear();
        lock(&h.sink.notes).clear();
        lock(&h.speech.transcripts).push_back(Err(error));
        h.hold(Key::F13);
        assert_eq!(last_error(&h), notice);
        assert_eq!(h.sink.wait_note("app.notify.dictationFailed").body, body);
    }
    assert!(h.input.texts().is_empty());
    engine.shutdown();
}

#[test]
fn a_missing_key_fails_before_anything_is_sent() {
    let h = Harness::new("no-key");
    h.config(json!({
        "audio_provider": "mistral",
        "audio_endpoint": "https://api.mistral.ai/v1/audio/transcriptions",
        "audio_model": "voxtral-mini-latest",
        "audio_api_key": ""
    }));
    let engine = h.start();
    assert_eq!(engine.settings_state()["dictation"]["status"], "noKey");
    h.hold(Key::F13);
    assert_eq!(last_error(&h), "pill.error.noKey");
    assert!(h.speech.heard().is_empty(), "no audio left the computer");
    assert_eq!(
        h.sink.wait_note("app.notify.dictationFailed").body,
        "No audio API key set. Open Settings > Transcription and add a key."
    );
    engine.shutdown();
}

#[test]
fn a_microphone_that_won_t_open_fails_and_the_next_press_works() {
    let h = Harness::new("no-mic");
    // A local server that needs no key, so the status is about the microphone alone.
    h.config(json!({
        "audio_provider": "custom",
        "audio_endpoint": "http://127.0.0.1:9/v1/audio/transcriptions",
        "audio_model": "whisper"
    }));
    lock(&h.mic.plans).push_back(MicPlan::Fail("No microphone is available.".into()));
    let engine = h.start();
    h.keys.down(Key::F13);
    assert_eq!(last_error(&h), "pill.error.mic");
    assert_eq!(
        h.sink.wait_note("app.notify.dictationFailed").body,
        "Microphone error: No microphone is available."
    );
    wait_for("the settings status", || {
        engine.settings_state()["dictation"]["status"] == "noMic"
    });
    h.keys.up(Key::F13);
    h.speech.say("works again");
    h.hold(Key::F13);
    wait_for("the insertion", || h.input.texts() == ["works again"]);
    assert_eq!(engine.settings_state()["dictation"]["status"], "ready");
    engine.shutdown();
}

#[test]
fn an_elevated_app_and_a_missing_selection_have_their_own_notices() {
    let h = Harness::new("blocked");
    h.config(json!({"rewrite_api_key": "k"}));
    *lock(&h.input.fail) = Some(InputError::Blocked);
    let engine = h.start();
    h.hold(Key::F13);
    assert_eq!(last_error(&h), "pill.error.blocked");
    assert_eq!(
        h.sink.wait_note("app.notify.dictationFailed").body,
        "Windows blocked typing into an app that runs as administrator."
    );
    *lock(&h.input.fail) = None;
    lock(&h.sink.pills).clear();
    // Rewrite without a selection: the instruction is never transcribed.
    let transcribed = h.speech.heard().len();
    h.hold(Key::F14);
    assert_eq!(last_error(&h), "pill.error.selectText");
    assert_eq!(h.speech.heard().len(), transcribed);
    *lock(&h.input.selection) = Some("x".repeat(12_001));
    lock(&h.sink.pills).clear();
    h.hold(Key::F14);
    assert_eq!(last_error(&h), "pill.error.selectionTooLong");
    engine.shutdown();
}

#[test]
fn no_text_box_warns_but_inserts_anyway() {
    let h = Harness::new("no-text-box");
    h.config(json!({}));
    *lock(&h.input.target) = TextTarget::NotSelected;
    let engine = h.start();
    h.keys.down(Key::F13);
    let held = h.sink.wait_phase(PillPhase::Warning);
    assert_eq!(held.notice.unwrap().key, "pill.selectTextBox");
    wait_for("audio", || h.mic.delivered.load(Ordering::SeqCst) >= 3200);
    h.keys.up(Key::F13);
    wait_for("the insertion", || h.input.texts().len() == 1);
    h.sink.wait_note("app.notify.noTextBox");
    h.sink.wait_hidden_after(PillPhase::Warning);
    engine.shutdown();
}

#[test]
fn insertion_waits_while_a_hotkey_is_held() {
    let h = Harness::new("defer");
    h.config(json!({}));
    *lock(&h.speech.transcribe_delay) = Duration::from_millis(300);
    let engine = h.start();
    h.speech.say("first");
    h.speech.say("second");
    h.hold(Key::F13);
    // The next dictation starts while the first is still being transcribed.
    let before = h.mic.delivered.load(Ordering::SeqCst);
    h.keys.down(Key::F13);
    wait_for("the second recording", || {
        h.mic.opens.load(Ordering::SeqCst) == 2
    });
    std::thread::sleep(Duration::from_millis(600));
    assert!(
        h.input.texts().is_empty(),
        "nothing is pasted while the key is down (Right Alt would make Ctrl+V AltGr+V)"
    );
    wait_for("audio", || {
        h.mic.delivered.load(Ordering::SeqCst) >= before + 3200
    });
    h.keys.up(Key::F13);
    wait_for("both insertions", || h.input.texts().len() == 2);
    assert_eq!(h.input.texts(), ["first", "second"], "in recording order");
    assert!(lock(&h.input.inserted).iter().all(|i| i.held.is_empty()));
    engine.shutdown();
}

#[test]
fn a_settings_key_change_applies_without_a_restart() {
    let h = Harness::new("keys");
    h.config(json!({}));
    let engine = h.start();
    engine
        .settings_set("dictation.hotkey", json!("f15"))
        .unwrap();
    h.speech.say("new key");
    h.hold(Key::F15);
    wait_for("the insertion", || h.input.texts() == ["new key"]);
    // The old key does nothing now.
    h.keys.down(Key::F13);
    std::thread::sleep(Duration::from_millis(100));
    h.keys.up(Key::F13);
    assert_eq!(h.mic.opens.load(Ordering::SeqCst), 1);
    engine.shutdown();
}

#[test]
fn the_stop_click_without_a_meeting_does_nothing_and_shutdown_inserts_nothing() {
    let h = Harness::new("shutdown");
    h.config(json!({}));
    *lock(&h.speech.transcribe_delay) = Duration::from_millis(500);
    let engine = h.start();
    engine.pill_stop_clicked();
    engine.pill_stop_clicked();
    h.hold(Key::F13);
    h.sink.wait_phase(PillPhase::Transcribing);
    engine.shutdown();
    std::thread::sleep(Duration::from_millis(800));
    assert!(h.input.texts().is_empty(), "no insertion once Voice quits");
    assert!(!h.sink.last_pill().unwrap().visible);
}
