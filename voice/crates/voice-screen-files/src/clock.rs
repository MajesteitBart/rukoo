//! Meeting time in the screen process, from the recorder's anchors.
//!
//! The anchor is the latest `session` or `heartbeat` line of the recorder's current session.
//! With `boot` on both sides, `t = anchor.t + (boot - anchor.boot) / 10_000`; otherwise
//! `t = anchor.t + (wall - anchor.wall)`. Time never steps back.
//!
//! The recorder's `t` within a session is its start plus `Instant`, which is QPC on Windows, and
//! interrupt time comes from the same counter and counts sleep too, so the boot mapping is exact
//! to the millisecond. The wall clock is late by the recorder's setup time in a `session` line
//! and follows time syncs, so it is only the fallback.

use crate::timeline::TimelineLine;

/// A recorder line's meeting time with the clocks read next to it. `boot` is Windows interrupt
/// time in 100 ns units.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Anchor {
    pub t: u64,
    pub wall: u64,
    pub boot: Option<u64>,
}

impl Anchor {
    /// Meeting time at `now` by this anchor, which can be before the anchor and even below 0.
    fn map(&self, now: Now) -> i64 {
        match (self.boot, now.boot) {
            (Some(anchor), Some(boot)) => {
                self.t as i64 + (boot as i64 - anchor as i64).div_euclid(BOOT_UNITS_PER_MS)
            }
            _ => self.t as i64 + (now.wall as i64 - self.wall as i64),
        }
    }
}

/// 100 ns units per millisecond.
const BOOT_UNITS_PER_MS: i64 = 10_000;

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
        ScreenClock {
            anchor: None,
            session: 0,
            last: 0,
        }
    }

    /// Takes `session` and `heartbeat` lines; ignores the rest. `now` is when the line is fed,
    /// for measuring how far a new session moves the mapping.
    ///
    /// A heartbeat only refreshes the anchor of the current session. A `session` line with a new
    /// number re-anchors and reports the jump at `now`; the caller ends the open video file when
    /// it is more than `REANCHOR_SPLIT_MS` either way.
    pub fn feed(&mut self, line: &TimelineLine, now: Now) -> Fed {
        let (anchor, session) = match *line {
            TimelineLine::Session {
                t,
                wall,
                boot,
                session,
            } => (Anchor { t, wall, boot }, Some(session)),
            TimelineLine::Heartbeat { t, wall, boot } => (Anchor { t, wall, boot }, None),
            _ => return Fed::Nothing,
        };
        let Some(old) = self.anchor else {
            self.anchor = Some(anchor);
            self.session = session.unwrap_or(0);
            return Fed::Anchored;
        };
        self.anchor = Some(anchor);
        match session {
            Some(session) if session != self.session => {
                self.session = session;
                Fed::Reanchored {
                    jump_ms: anchor.map(now) - old.map(now),
                }
            }
            _ => Fed::Nothing,
        }
    }

    /// Meeting time now: never backward; `None` before an anchor.
    pub fn at(&mut self, now: Now) -> Option<u64> {
        let t = self.anchor?.map(now).max(0) as u64;
        self.last = self.last.max(t);
        Some(self.last)
    }

    /// Whether the mapping uses `boot` (`anchor: "boot"` in the journal's `session` line).
    pub fn uses_boot(&self) -> bool {
        self.anchor.is_some_and(|a| a.boot.is_some())
    }

    /// The current anchor, for logs and tests.
    pub fn anchor(&self) -> Option<Anchor> {
        self.anchor
    }
}

impl Default for ScreenClock {
    fn default() -> ScreenClock {
        ScreenClock::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WALL0: u64 = 1_793_384_408_939;
    const BOOT0: u64 = 123_456_000_000;

    fn session(t: u64, wall: u64, boot: Option<u64>, session: u64) -> TimelineLine {
        TimelineLine::Session {
            t,
            wall,
            boot,
            session,
        }
    }

    fn heartbeat(t: u64, wall: u64, boot: Option<u64>) -> TimelineLine {
        TimelineLine::Heartbeat { t, wall, boot }
    }

    fn now(boot_ms: u64, wall_ms: u64) -> Now {
        Now {
            boot: Some(BOOT0 + boot_ms * 10_000),
            wall: WALL0 + wall_ms,
        }
    }

    #[test]
    fn nothing_before_an_anchor() {
        let mut clock = ScreenClock::new();
        assert_eq!(clock.at(now(0, 0)), None);
        assert!(!clock.uses_boot());
        assert_eq!(
            clock.feed(&TimelineLine::Pause { t: 5 }, now(0, 0)),
            Fed::Nothing
        );
        assert_eq!(clock.at(now(0, 0)), None);
    }

    #[test]
    fn maps_interrupt_time_exactly() {
        let mut clock = ScreenClock::new();
        // The session's wall is 15 ms early, as measured; boot doesn't care.
        let fed = clock.feed(&session(0, WALL0 - 15, Some(BOOT0), 1), now(30, 30));
        assert_eq!(fed, Fed::Anchored);
        assert!(clock.uses_boot());
        assert_eq!(clock.at(now(30, 999)), Some(30));
        // 100 ns resolution, rounded down to the millisecond.
        let mut later = now(1_234, 0);
        later.boot = later.boot.map(|b| b + 9_999);
        assert_eq!(clock.at(later), Some(1_234));
        // A heartbeat refreshes the anchor; the mapping stays where it was.
        let fed = clock.feed(
            &heartbeat(2_000, WALL0 + 2_013, Some(BOOT0 + 20_000_000)),
            now(2_010, 2_010),
        );
        assert_eq!(fed, Fed::Nothing);
        assert_eq!(clock.at(now(2_500, 0)), Some(2_500));
        assert_eq!(clock.anchor().unwrap().t, 2_000);
    }

    #[test]
    fn falls_back_to_the_wall_clock_without_boot() {
        let mut clock = ScreenClock::new();
        clock.feed(&session(0, WALL0, None, 1), now(0, 0));
        assert!(!clock.uses_boot());
        assert_eq!(clock.at(now(9_999, 250)), Some(250));
        // The process that can't read boot maps by wall even with a boot anchor.
        let mut clock = ScreenClock::new();
        clock.feed(&session(0, WALL0, Some(BOOT0), 1), now(0, 0));
        let no_boot = Now {
            boot: None,
            wall: WALL0 + 700,
        };
        assert_eq!(clock.at(no_boot), Some(700));
        // A heartbeat without boot after one with it switches the mapping to the wall.
        clock.feed(&heartbeat(1_000, WALL0 + 1_000, None), now(1_000, 1_000));
        assert!(!clock.uses_boot());
        assert_eq!(clock.at(now(0, 1_400)), Some(1_400));
    }

    #[test]
    fn never_goes_backward() {
        let mut clock = ScreenClock::new();
        clock.feed(&session(0, WALL0, None, 1), now(0, 0));
        assert_eq!(clock.at(now(0, 5_000)), Some(5_000));
        // The wall clock stepped back a minute: time holds.
        assert_eq!(clock.at(now(0, 4_000)), Some(5_000));
        assert_eq!(clock.at(now(0, 5_200)), Some(5_200));
        // A frame captured before the anchor maps below it, but never below what was given out.
        let mut clock = ScreenClock::new();
        clock.feed(&session(10_000, WALL0, Some(BOOT0), 2), now(0, 0));
        assert_eq!(clock.at(now(0, 0)), Some(10_000));
        let early = Now {
            boot: Some(BOOT0 - 30_000),
            wall: WALL0,
        };
        assert_eq!(clock.at(early), Some(10_000));
        // Before meeting time 0 it is 0.
        let mut clock = ScreenClock::new();
        clock.feed(&session(0, WALL0, Some(BOOT0), 1), now(0, 0));
        assert_eq!(
            clock.at(Now {
                boot: Some(BOOT0 - 50_000),
                wall: WALL0
            }),
            Some(0)
        );
    }

    #[test]
    fn a_new_session_reanchors_and_reports_its_jump() {
        let mut clock = ScreenClock::new();
        clock.feed(&session(0, WALL0, Some(BOOT0), 1), now(0, 0));
        clock.feed(
            &heartbeat(9_000, WALL0 + 9_000, Some(BOOT0 + 90_000_000)),
            now(9_000, 9_000),
        );
        // The recorder died at 9.5 s and came back at boot 12 s, starting its clock from the wall
        // time since session 1: 12,080 ms, so the old mapping (12,000) is 80 ms behind.
        let fed = clock.feed(
            &session(12_080, WALL0 + 12_080, Some(BOOT0 + 120_000_000), 2),
            now(12_000, 12_080),
        );
        assert_eq!(fed, Fed::Reanchored { jump_ms: 80 });
        const { assert!(80 > REANCHOR_SPLIT_MS) };
        assert_eq!(clock.at(now(12_500, 0)), Some(12_580));
        // A small jump is reported too; the caller keeps the file. By session 2's mapping, boot
        // 19,990 ms is 12,080 + 7,990 = 20,070.
        let fed = clock.feed(
            &session(20_080, WALL0 + 20_080, Some(BOOT0 + 199_900_000), 3),
            now(19_990, 20_080),
        );
        assert_eq!(fed, Fed::Reanchored { jump_ms: 10 });
        // A session line seen again, as when the timeline is read from the start, keeps it.
        let fed = clock.feed(
            &session(20_080, WALL0 + 20_080, Some(BOOT0 + 199_900_000), 3),
            now(19_995, 20_085),
        );
        assert_eq!(fed, Fed::Nothing);
        // A session that jumps back holds time until the new mapping catches up.
        let mut clock = ScreenClock::new();
        clock.feed(&session(0, WALL0, Some(BOOT0), 1), now(0, 0));
        assert_eq!(clock.at(now(5_000, 0)), Some(5_000));
        let fed = clock.feed(
            &session(4_000, WALL0 + 4_000, Some(BOOT0 + 50_000_000), 2),
            now(5_000, 5_000),
        );
        assert_eq!(fed, Fed::Reanchored { jump_ms: -1_000 });
        assert_eq!(clock.at(now(5_500, 0)), Some(5_000));
        assert_eq!(clock.at(now(6_200, 0)), Some(5_200));
    }

    #[test]
    fn a_heartbeat_can_be_the_first_anchor() {
        let mut clock = ScreenClock::new();
        let fed = clock.feed(&heartbeat(3_000, WALL0 + 3_000, Some(BOOT0)), now(0, 3_000));
        assert_eq!(fed, Fed::Anchored);
        assert_eq!(clock.at(now(250, 0)), Some(3_250));
        // The first session line after it is a new session.
        let fed = clock.feed(
            &session(3_000, WALL0 + 3_000, Some(BOOT0), 1),
            now(300, 3_300),
        );
        assert_eq!(fed, Fed::Reanchored { jump_ms: 0 });
    }
}
