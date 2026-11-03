//! The clocks the screen process reads. `boot` is Windows interrupt time: it counts sleep, every
//! process shares it, and the recorder reads it next to `t` in its `session` and `heartbeat`
//! lines, so `voice_screen_files::clock::ScreenClock` maps it onto the meeting clock.

use std::time::{SystemTime, UNIX_EPOCH};

use voice_screen_files::clock::Now;
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
use windows::Win32::System::WindowsProgramming::{
    QueryInterruptTimePrecise, QueryUnbiasedInterruptTimePrecise,
};

/// Interrupt time in 100 ns units: counts sleep.
pub fn boot_100ns() -> u64 {
    unsafe { QueryInterruptTimePrecise() }
}

/// Unbiased interrupt time in 100 ns units: awake time only, for the 60 s orphan rule, so a
/// computer that slept doesn't count as a dead recorder.
pub fn awake_100ns() -> u64 {
    unsafe { QueryUnbiasedInterruptTimePrecise() }
}

/// The performance counter in 100 ns units, the clock of a capture frame's
/// `SystemRelativeTime`.
pub fn qpc_100ns() -> u64 {
    let (mut counter, mut frequency) = (0i64, 0i64);
    unsafe {
        let _ = QueryPerformanceCounter(&mut counter);
        let _ = QueryPerformanceFrequency(&mut frequency);
    }
    if frequency <= 0 {
        return 0;
    }
    (counter as u128 * 10_000_000 / frequency as u128) as u64
}

/// The boot time of a captured frame: the clocks are read back to back, so only the frame's age,
/// a few ms, goes through the performance counter.
pub fn frame_boot(system_relative_time_100ns: i64) -> u64 {
    let boot = boot_100ns();
    let qpc = qpc_100ns();
    let age = qpc.saturating_sub(system_relative_time_100ns.max(0) as u64);
    boot.saturating_sub(age)
}

/// Unix time in ms.
pub fn wall_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Both clocks now, for `ScreenClock`.
pub fn now() -> Now {
    Now {
        boot: Some(boot_100ns()),
        wall: wall_ms(),
    }
}

/// The clocks at an earlier boot time: the wall clock moved back by the same age.
pub fn at_boot(boot: u64) -> Now {
    let now_boot = boot_100ns();
    let age_ms = now_boot.saturating_sub(boot) / 10_000;
    Now {
        boot: Some(boot),
        wall: wall_ms().saturating_sub(age_ms),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_frame_is_a_few_ms_old() {
        let srt = qpc_100ns() as i64;
        let boot = frame_boot(srt);
        let now = boot_100ns();
        assert!(boot <= now);
        assert!(now - boot < 50 * 10_000, "{} ms", (now - boot) / 10_000);
        let old = frame_boot(srt - 1_000_000);
        assert!(
            boot - old >= 900_000 && boot - old <= 1_500_000,
            "{}",
            boot - old
        );
    }

    #[test]
    fn interrupt_time_tracks_the_performance_counter() {
        let (b0, q0) = (boot_100ns(), qpc_100ns());
        std::thread::sleep(std::time::Duration::from_millis(200));
        let (b1, q1) = (boot_100ns(), qpc_100ns());
        let drift = (b1 - b0).abs_diff(q1 - q0);
        assert!(drift < 20_000, "drift {drift} x 100 ns");
    }
}
