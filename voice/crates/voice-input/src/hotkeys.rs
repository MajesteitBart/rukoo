//! Hotkey presses and releases read from physical key state (port of ownkey-windows #11).
//!
//! Windows stops waiting for a low-level keyboard hook after
//! `LowLevelHooksTimeout`, and the hook never sees the events it missed. In
//! Ownkey a slow microphone open on the hook thread lost the hotkey release
//! and left push-to-talk stuck. So there is no hook: one thread samples key
//! state every 40 ms and queues each change, and the consumer handles them on
//! another thread. A slow handler delays later presses and releases but can't
//! hide them, and other apps never wait for Voice's input handling.

use std::panic::{self, AssertUnwindSafe};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use crate::{InputError, Key};

/// How often key state is sampled. 25 polls a second cost about 0.1% of one
/// core; 20 ms cost 0.65% (measured for Ownkey).
pub const POLL_INTERVAL: Duration = Duration::from_millis(40);

/// A change in a hotkey's physical state.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum HotkeyEvent {
    Pressed(Key),
    Released(Key),
}

impl HotkeyEvent {
    pub fn key(self) -> Key {
        match self {
            HotkeyEvent::Pressed(key) | HotkeyEvent::Released(key) => key,
        }
    }
}

#[derive(Debug, Default)]
struct Shared {
    stopped: Mutex<bool>,
    wake: Condvar,
}

impl Shared {
    fn stop(&self) {
        *self.stopped.lock().unwrap_or_else(PoisonError::into_inner) = true;
        self.wake.notify_all();
    }

    fn is_stopped(&self) -> bool {
        *self.stopped.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Sleeps for `timeout` or until stopped. Returns whether it was stopped.
    fn wait(&self, timeout: Duration) -> bool {
        let stopped = self.stopped.lock().unwrap_or_else(PoisonError::into_inner);
        let (stopped, _) = self
            .wake
            .wait_timeout_while(stopped, timeout, |stopped| !*stopped)
            .unwrap_or_else(PoisonError::into_inner);
        *stopped
    }
}

/// Stops a [`HotkeyPoller`] from anywhere, including from its own handler.
#[derive(Clone, Debug)]
pub struct Stopper(Arc<Shared>);

impl Stopper {
    pub fn stop(&self) {
        self.0.stop();
    }

    pub fn is_stopped(&self) -> bool {
        self.0.is_stopped()
    }
}

/// Polls hotkeys on a background thread named `hotkeys`.
///
/// A key that is already held when polling starts counts as a press. A tap
/// shorter than one poll interval is never seen, which is fine for
/// push-to-talk. Dropping the poller stops it without waiting for its threads,
/// because a handler may drop or stop its own poller.
#[derive(Debug)]
pub struct HotkeyPoller {
    shared: Arc<Shared>,
    poller: Option<JoinHandle<()>>,
    dispatcher: Option<JoinHandle<()>>,
}

impl HotkeyPoller {
    /// Polls the physical keyboard and sends every change to `tx` in order.
    /// Fails with [`InputError::Unsupported`] outside Windows.
    pub fn spawn(keys: Vec<Key>, tx: Sender<HotkeyEvent>) -> Result<HotkeyPoller, InputError> {
        HotkeyPoller::spawn_with(keys, tx, crate::sys::key_state()?, POLL_INTERVAL)
    }

    /// Polls the physical keyboard and runs `handler` for every change, in
    /// order, on a thread named `hotkey-callbacks`. A panicking handler is
    /// reported by the panic hook and the next event still runs: one failed
    /// recording must not end push-to-talk.
    pub fn spawn_handler<H>(keys: Vec<Key>, handler: H) -> Result<HotkeyPoller, InputError>
    where
        H: FnMut(HotkeyEvent) + Send + 'static,
    {
        HotkeyPoller::spawn_handler_with(keys, crate::sys::key_state()?, POLL_INTERVAL, handler)
    }

    /// [`HotkeyPoller::spawn`] with an injected key-state function, for tests
    /// and for platforms that read keys another way.
    pub fn spawn_with<S>(
        keys: Vec<Key>,
        tx: Sender<HotkeyEvent>,
        key_state: S,
        interval: Duration,
    ) -> Result<HotkeyPoller, InputError>
    where
        S: FnMut(Key) -> bool + Send + 'static,
    {
        let shared = Arc::new(Shared::default());
        let poller = start_polling(keys, key_state, interval, tx, &shared)?;
        Ok(HotkeyPoller {
            shared,
            poller: Some(poller),
            dispatcher: None,
        })
    }

    /// [`HotkeyPoller::spawn_handler`] with an injected key-state function.
    pub fn spawn_handler_with<S, H>(
        keys: Vec<Key>,
        key_state: S,
        interval: Duration,
        handler: H,
    ) -> Result<HotkeyPoller, InputError>
    where
        S: FnMut(Key) -> bool + Send + 'static,
        H: FnMut(HotkeyEvent) + Send + 'static,
    {
        let shared = Arc::new(Shared::default());
        let (tx, rx) = mpsc::channel();
        let dispatcher = thread::Builder::new()
            .name("hotkey-callbacks".into())
            .spawn({
                let shared = Arc::clone(&shared);
                move || dispatch(rx, &shared, handler)
            })
            .map_err(thread_error)?;
        // If polling can't start, its sender is dropped and the dispatcher ends.
        let poller = start_polling(keys, key_state, interval, tx, &shared)?;
        Ok(HotkeyPoller {
            shared,
            poller: Some(poller),
            dispatcher: Some(dispatcher),
        })
    }

    /// Stops polling. Never waits, so a handler can call it. Changes that were
    /// queued but not yet handled are dropped, as in Ownkey.
    pub fn stop(&self) {
        self.shared.stop();
    }

    /// A handle that stops this poller, for handlers and other threads.
    pub fn stopper(&self) -> Stopper {
        Stopper(Arc::clone(&self.shared))
    }

    /// Whether the polling thread is still running.
    pub fn is_running(&self) -> bool {
        self.poller
            .as_ref()
            .is_some_and(|thread| !thread.is_finished())
    }

    /// Stops polling and waits for both threads to end. A handler that is
    /// still running is waited for. Called from the handler itself, it skips
    /// waiting for its own thread.
    pub fn join(mut self) {
        self.stop();
        for thread in [self.poller.take(), self.dispatcher.take()]
            .into_iter()
            .flatten()
        {
            if thread.thread().id() != thread::current().id() {
                let _ = thread.join();
            }
        }
    }
}

impl Drop for HotkeyPoller {
    fn drop(&mut self) {
        self.stop();
    }
}

fn start_polling<S>(
    keys: Vec<Key>,
    key_state: S,
    interval: Duration,
    tx: Sender<HotkeyEvent>,
    shared: &Arc<Shared>,
) -> Result<JoinHandle<()>, InputError>
where
    S: FnMut(Key) -> bool + Send + 'static,
{
    let mut unique = Vec::with_capacity(keys.len());
    for key in keys {
        if !unique.contains(&key) {
            unique.push(key);
        }
    }
    let shared = Arc::clone(shared);
    thread::Builder::new()
        .name("hotkeys".into())
        .spawn(move || poll(&unique, key_state, interval, &tx, &shared))
        .map_err(thread_error)
}

fn poll<S>(
    keys: &[Key],
    mut key_state: S,
    interval: Duration,
    tx: &Sender<HotkeyEvent>,
    shared: &Shared,
) where
    S: FnMut(Key) -> bool,
{
    // Starts with nothing held, so a key that is already down counts as a
    // press, as key repeat did for Ownkey's old hook.
    let mut held = vec![false; keys.len()];
    loop {
        for (&key, was_down) in keys.iter().zip(held.iter_mut()) {
            let down = key_state(key);
            if down == *was_down {
                continue;
            }
            *was_down = down;
            if shared.is_stopped() {
                return;
            }
            let event = if down {
                HotkeyEvent::Pressed(key)
            } else {
                HotkeyEvent::Released(key)
            };
            if tx.send(event).is_err() {
                return; // nobody is listening any more
            }
        }
        if shared.wait(interval) {
            return;
        }
    }
}

fn dispatch<H>(rx: Receiver<HotkeyEvent>, shared: &Shared, mut handler: H)
where
    H: FnMut(HotkeyEvent),
{
    // Ends when the polling thread exits and drops its sender.
    for event in rx {
        if shared.is_stopped() {
            return;
        }
        // One failed recording must not end push-to-talk. The panic hook has
        // already reported the panic.
        let _ = panic::catch_unwind(AssertUnwindSafe(|| handler(event)));
    }
}

fn thread_error(err: std::io::Error) -> InputError {
    InputError::System(format!("Could not start the hotkey listener: {err}"))
}
