//! Steps of applying another computer's settings where a test makes Voice stop, fail or wait, on
//! the test's own thread. Nothing else sets them, so outside tests every step goes on.

use std::cell::RefCell;
use std::sync::mpsc::{Receiver, Sender};

use crate::{SyncError, SyncErrorKind};

/// What happens at a step.
enum At {
    /// Panics, as a hard stop of Voice would end it there.
    Stop,
    /// The step fails.
    Fail,
    /// Says so on the sender, then waits until the receiver gets something or its sender goes.
    Pause(Sender<()>, Receiver<()>),
}

thread_local! {
    /// (step, what happens there). Each counts once.
    static AT: RefCell<Vec<(String, At)>> = const { RefCell::new(Vec::new()) };
}

fn set(step: &str, at: At) {
    AT.with(|list| list.borrow_mut().push((step.into(), at)));
}

/// Voice stops right after `step` on this thread, once.
#[doc(hidden)]
pub fn stop_after(step: &str) {
    set(step, At::Stop);
}

/// `step` fails on this thread, once.
#[doc(hidden)]
pub fn fail_after(step: &str) {
    set(step, At::Fail);
}

/// Voice waits right after `step` on this thread, once: it sends on `reached`, then goes on when
/// `go` gets something or its sender is dropped.
#[doc(hidden)]
pub fn pause_after(step: &str, reached: Sender<()>, go: Receiver<()>) {
    set(step, At::Pause(reached, go));
}

/// Called after each step.
#[doc(hidden)]
pub fn reached(step: &str) -> Result<(), SyncError> {
    let hit = AT.with(|list| {
        let mut list = list.borrow_mut();
        let i = list.iter().position(|(s, _)| s == step)?;
        Some(list.remove(i).1)
    });
    match hit {
        Some(At::Stop) => panic!("Voice stops after {step}"),
        Some(At::Fail) => Err(SyncError::new(
            SyncErrorKind::Local,
            format!("The test failed {step}."),
        )),
        Some(At::Pause(reached, go)) => {
            let _ = reached.send(());
            let _ = go.recv();
            Ok(())
        }
        None => Ok(()),
    }
}
