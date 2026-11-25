//! Steps of applying another computer's settings where a test makes Voice stop or fail, on the
//! test's own thread. Nothing else sets them, so outside tests every step goes on.

use std::cell::RefCell;

use crate::{SyncError, SyncErrorKind};

thread_local! {
    /// (step, stop): a stop panics, as a hard stop of Voice would end it there; otherwise the step
    /// fails. Each counts once.
    static AT: RefCell<Vec<(String, bool)>> = const { RefCell::new(Vec::new()) };
}

/// Voice stops right after `step` on this thread, once.
#[doc(hidden)]
pub fn stop_after(step: &str) {
    AT.with(|at| at.borrow_mut().push((step.into(), true)));
}

/// `step` fails on this thread, once.
#[doc(hidden)]
pub fn fail_after(step: &str) {
    AT.with(|at| at.borrow_mut().push((step.into(), false)));
}

/// Called after each step.
#[doc(hidden)]
pub fn reached(step: &str) -> Result<(), SyncError> {
    let hit = AT.with(|at| {
        let mut at = at.borrow_mut();
        let i = at.iter().position(|(s, _)| s == step)?;
        Some(at.remove(i).1)
    });
    match hit {
        Some(true) => panic!("Voice stops after {step}"),
        Some(false) => Err(SyncError::new(
            SyncErrorKind::Local,
            format!("The test failed {step}."),
        )),
        None => Ok(()),
    }
}
