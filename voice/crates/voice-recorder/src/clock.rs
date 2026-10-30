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
/// The computer slept when more time passed than it was awake, by more than this.
pub const SUSPEND_MS: u64 = 3_000;

/// One reading of the clocks that tell sleep apart, in milliseconds. `awake` stops while the
/// computer sleeps and `elapsed` keeps counting; neither follows a change of the wall clock.
/// `wall` is the wall clock at the same moment, for the timeline.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Stamp {
    pub awake: u64,
    pub elapsed: u64,
    pub wall: u64,
}

impl Stamp {
    pub fn now() -> Stamp {
        let (awake, elapsed) = sleep_clocks();
        Stamp {
            awake,
            elapsed,
            wall: wall_ms(),
        }
    }
}

/// Windows counts interrupt time with and without the time spent asleep; the difference is
/// exactly the sleep. Rust's `Instant` isn't used for this: whether it counts sleep isn't
/// specified, and on Windows it does.
#[cfg(windows)]
fn sleep_clocks() -> (u64, u64) {
    use windows::Win32::System::WindowsProgramming::{
        QueryInterruptTime, QueryUnbiasedInterruptTime,
    };
    // Both count 100 ns units since boot.
    let mut awake = 0u64;
    // SAFETY: both only write the u64 they are given.
    let (ok, elapsed) = unsafe {
        let ok = QueryUnbiasedInterruptTime(&mut awake).as_bool();
        (ok, QueryInterruptTime())
    };
    let elapsed = elapsed / 10_000;
    // Without the unbiased count, no sleep can be seen; that is what the call failing means.
    let awake = if ok { awake / 10_000 } else { elapsed };
    (awake, elapsed)
}

/// Elsewhere the monotonic clock stops during sleep on Linux and macOS, and the wall clock stands
/// in for the time that passed, so a wall-clock step counts as sleep there. Voice 0.1 records
/// devices only on Windows.
#[cfg(not(windows))]
fn sleep_clocks() -> (u64, u64) {
    use std::sync::OnceLock;
    static BASE: OnceLock<Instant> = OnceLock::new();
    let awake = BASE.get_or_init(Instant::now).elapsed().as_millis() as u64;
    (awake, wall_ms())
}

/// How long the computer slept between two readings, when it slept more than `SUSPEND_MS`.
/// A thread that was stalled advances both clocks alike, and a wall-clock step neither, so
/// neither counts.
pub fn slept(previous: &Stamp, now: &Stamp) -> Option<u64> {
    let passed = now.elapsed.saturating_sub(previous.elapsed);
    let awake = now.awake.saturating_sub(previous.awake);
    let slept = passed.saturating_sub(awake);
    (slept > SUSPEND_MS).then_some(slept)
}

/// The meeting time after a sleep found between a heartbeat at `heartbeat_t` and now: the time
/// that passed since the heartbeat, but never more than `slept` past `current`, the clock's own
/// reading. A clock that already counted the sleep doesn't move again.
pub fn after_sleep(heartbeat_t: u64, current: u64, previous: &Stamp, now: &Stamp) -> u64 {
    let passed = now.elapsed.saturating_sub(previous.elapsed);
    let slept = slept(previous, now).unwrap_or(0);
    (heartbeat_t + passed).min(current + slept).max(current)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stamp(awake: u64, elapsed: u64, wall: u64) -> Stamp {
        Stamp {
            awake,
            elapsed,
            wall,
        }
    }

    #[test]
    fn resumed_sessions_follow_the_wall_clock_but_never_go_back() {
        assert_eq!(resumed_start(1_000, 61_000, 30_000), 60_000);
        assert_eq!(resumed_start(1_000, 20_000, 30_000), 30_000);
        assert_eq!(resumed_start(90_000, 20_000, 30_000), 30_000);
    }

    #[test]
    fn a_sleep_of_more_than_three_seconds_counts() {
        let before = stamp(10_000, 10_000, 1_793_000_010_000);
        // One second awake, then a minute asleep.
        let after = stamp(11_000, 71_000, 1_793_000_071_000);
        assert_eq!(slept(&before, &after), Some(60_000));
        assert_eq!(slept(&before, &stamp(11_000, 14_000, 0)), None);
        assert_eq!(slept(&before, &stamp(11_000, 14_001, 0)), Some(3_001));
    }

    #[test]
    fn a_stalled_thread_is_not_a_sleep() {
        // The recorder thread was blocked for 6 s, opening a device: every clock moved 6 s.
        let before = stamp(10_000, 10_000, 1_793_000_010_000);
        let after = stamp(16_000, 16_000, 1_793_000_016_000);
        assert_eq!(slept(&before, &after), None);
    }

    #[test]
    fn a_wall_clock_step_is_not_a_sleep() {
        // A time sync moved the wall clock a minute forward, then back; one second passed.
        let before = stamp(10_000, 10_000, 1_793_000_010_000);
        assert_eq!(
            slept(&before, &stamp(11_000, 11_000, 1_793_000_071_000)),
            None
        );
        assert_eq!(
            slept(&before, &stamp(11_000, 11_000, 1_792_999_951_000)),
            None
        );
    }

    #[test]
    fn the_clock_moves_by_the_sleep_and_never_by_a_wall_step() {
        let before = stamp(10_000, 10_000, 0);
        let asleep = stamp(11_000, 71_000, 0);
        // A monotonic clock that stopped while asleep reads one second past the heartbeat.
        assert_eq!(after_sleep(5_000, 6_000, &before, &asleep), 66_000);
        // One that counted the sleep already is where it should be and stays.
        assert_eq!(after_sleep(5_000, 66_000, &before, &asleep), 66_000);
        // A wall-clock step moves nothing.
        let stepped = stamp(11_000, 11_000, 60_000);
        assert_eq!(after_sleep(5_000, 6_000, &before, &stepped), 6_000);
        // Never back.
        assert_eq!(after_sleep(5_000, 70_000, &before, &asleep), 70_000);
    }

    #[test]
    fn this_computer_reads_its_clocks() {
        let a = Stamp::now();
        std::thread::sleep(Duration::from_millis(30));
        let b = Stamp::now();
        assert!(b.awake >= a.awake && b.elapsed >= a.elapsed);
        assert!(b.elapsed - a.elapsed >= 10, "{a:?} {b:?}");
        assert_eq!(slept(&a, &b), None);
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
