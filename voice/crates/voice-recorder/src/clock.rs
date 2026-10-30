//! The meeting clock: wall-clock based across sessions, monotonic within one.

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Milliseconds since the Unix epoch.
pub fn wall_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as u64
}

/// Meeting time in milliseconds, advanced by the monotonic clock.
pub struct MeetingClock {
    base: u64,
    start: Instant,
}

impl MeetingClock {
    pub fn starting_at(t: u64) -> Self {
        Self {
            base: t,
            start: Instant::now(),
        }
    }

    pub fn now(&self) -> u64 {
        self.at(Instant::now())
    }

    /// The meeting time of an earlier or later instant. Instants before the clock's start
    /// count as its start.
    pub fn at(&self, instant: Instant) -> u64 {
        self.base + instant.saturating_duration_since(self.start).as_millis() as u64
    }

    /// Moves the clock forward to `t`; never backward.
    pub fn advance_to(&mut self, t: u64) {
        let now = Instant::now();
        let current = self.at(now);
        if t > current {
            self.base = t;
            self.start = now;
        }
    }
}

/// Where a resumed session's clock starts: the wall time since session 1 started, but never
/// before anything the timeline already holds, even when the wall clock went back.
pub fn resumed_start(first_wall: u64, now_wall: u64, latest_t: u64) -> u64 {
    now_wall.saturating_sub(first_wall).max(latest_t)
}

/// Heartbeats are written this often.
pub const HEARTBEAT: Duration = Duration::from_secs(1);
/// A wall-clock jump this much larger than the heartbeat interval means the computer slept.
pub const SUSPEND_JUMP_MS: u64 = 3_000;

/// Returns the wall-clock jump between two heartbeats when it means the computer slept.
pub fn suspend_jump(previous_wall: u64, now_wall: u64) -> Option<u64> {
    let delta = now_wall.saturating_sub(previous_wall);
    (delta > HEARTBEAT.as_millis() as u64 + SUSPEND_JUMP_MS).then_some(delta)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resumed_sessions_follow_the_wall_clock_but_never_go_back() {
        assert_eq!(resumed_start(1_000, 61_000, 30_000), 60_000);
        assert_eq!(resumed_start(1_000, 20_000, 30_000), 30_000);
        assert_eq!(resumed_start(90_000, 20_000, 30_000), 30_000);
    }

    #[test]
    fn detects_a_jump_of_more_than_three_seconds_between_heartbeats() {
        assert_eq!(suspend_jump(10_000, 11_000), None);
        assert_eq!(suspend_jump(10_000, 14_000), None);
        assert_eq!(suspend_jump(10_000, 14_001), Some(4_001));
        assert_eq!(suspend_jump(10_000, 70_000), Some(60_000));
        assert_eq!(suspend_jump(10_000, 5_000), None);
    }

    #[test]
    fn clock_moves_forward_only() {
        let mut clock = MeetingClock::starting_at(5_000);
        assert!(clock.now() >= 5_000);
        clock.advance_to(65_000);
        assert!(clock.now() >= 65_000);
        clock.advance_to(10_000);
        assert!(clock.now() >= 65_000);
        if let Some(before) = clock.start.checked_sub(Duration::from_millis(1)) {
            assert_eq!(clock.at(before), 65_000);
        }
    }
}
