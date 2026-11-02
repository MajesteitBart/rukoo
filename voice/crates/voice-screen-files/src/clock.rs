//! Meeting time in the screen process, from the recorder's anchors.
//!
//! The anchor is the latest `session` or `heartbeat` line of the recorder's current session.
//! With `boot` on both sides, `t = anchor.t + (boot - anchor.boot) / 10_000`; otherwise
//! `t = anchor.t + (wall - anchor.wall)`. Time never steps back.

use crate::timeline::TimelineLine;

/// A recorder line's meeting time with the clocks read next to it. `boot` is Windows interrupt
/// time in 100 ns units.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Anchor {
    pub t: u64,
    pub wall: u64,
    pub boot: Option<u64>,
}

/// The clocks read now: `boot` in 100 ns units, `wall` in Unix ms.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Now {
    pub boot: Option<u64>,
    pub wall: u64,
}

/// What feeding a timeline line did to the mapping.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fed {
    /// The line isn't an anchor, or kept the mapping.
    Nothing,
    /// The first anchor.
    Anchored,
    /// A new recorder session moved the mapping by `jump_ms` at the same instant.
    Reanchored { jump_ms: i64 },
}

/// A new session that moves the mapping by more than this ends the open video file
/// (`video_end` reason `clock`).
pub const REANCHOR_SPLIT_MS: i64 = 50;

#[derive(Debug)]
pub struct ScreenClock {
    anchor: Option<Anchor>,
    session: u64,
    last: u64,
}

impl ScreenClock {
    pub fn new() -> ScreenClock {
        todo!()
    }

    /// Takes `session` and `heartbeat` lines; ignores the rest.
    pub fn feed(&mut self, line: &TimelineLine, now: Now) -> Fed {
        let _ = (self.anchor, self.session, self.last, line, now);
        todo!()
    }

    /// Meeting time now: never backward; `None` before an anchor.
    pub fn at(&mut self, now: Now) -> Option<u64> {
        let _ = now;
        todo!()
    }

    /// Whether the mapping uses `boot` (`anchor: "boot"` in the journal's `session` line).
    pub fn uses_boot(&self) -> bool {
        todo!()
    }
}

impl Default for ScreenClock {
    fn default() -> ScreenClock {
        ScreenClock::new()
    }
}
