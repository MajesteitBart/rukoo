//! Test doubles for the hotkey tests: a keyboard the poller samples instead
//! of the physical one.

#![allow(dead_code)]

use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use voice_input::Key;

/// Poll fast so the tests run quickly.
pub const INTERVAL: Duration = Duration::from_millis(5);
/// How long a test waits for something that should happen. CI machines are slow.
pub const PATIENCE: Duration = Duration::from_secs(5);

pub fn wait_for(mut done: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + PATIENCE;
    while Instant::now() < deadline {
        if done() {
            return true;
        }
        thread::sleep(Duration::from_millis(2));
    }
    done()
}

/// Physical key state the poller reads.
pub struct Keyboard {
    pub held: Mutex<HashSet<Key>>,
    polls: AtomicUsize,
    /// How many keys the poller samples per tick.
    keys: usize,
}

impl Keyboard {
    pub fn new(keys: usize, held: &[Key]) -> Arc<Keyboard> {
        Arc::new(Keyboard {
            held: Mutex::new(held.iter().copied().collect()),
            polls: AtomicUsize::new(0),
            keys,
        })
    }

    /// The key-state function to give the poller.
    pub fn state(self: &Arc<Self>) -> impl FnMut(Key) -> bool + Send + 'static {
        let keyboard = Arc::clone(self);
        move |key| {
            keyboard.polls.fetch_add(1, Ordering::SeqCst);
            keyboard.held.lock().unwrap().contains(&key)
        }
    }

    /// Changes a key and waits until the poller has sampled it.
    pub fn set(&self, key: Key, down: bool) {
        {
            let mut held = self.held.lock().unwrap();
            if down {
                held.insert(key);
            } else {
                held.remove(&key);
            }
        }
        let seen = self.polls.load(Ordering::SeqCst);
        assert!(
            wait_for(|| self.polls.load(Ordering::SeqCst) >= seen + 2 * self.keys),
            "the poller stopped polling"
        );
    }
}

/// A gate a handler waits on, like Python's `threading.Event`.
pub struct Latch {
    open: Mutex<bool>,
    opened: Condvar,
}

impl Latch {
    pub fn new(open: bool) -> Latch {
        Latch {
            open: Mutex::new(open),
            opened: Condvar::new(),
        }
    }

    pub fn open(&self) {
        *self.open.lock().unwrap() = true;
        self.opened.notify_all();
    }

    /// Waits until open, at most [`PATIENCE`] so a broken test can't hang.
    pub fn wait(&self) {
        let open = self.open.lock().unwrap();
        let _ = self
            .opened
            .wait_timeout_while(open, PATIENCE, |open| !*open)
            .unwrap();
    }
}
