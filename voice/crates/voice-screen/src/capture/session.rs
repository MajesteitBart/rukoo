//! Whether the Windows session is locked or disconnected. Capture then shows the lock screen or
//! nothing, so the screen process stops capturing and writes `lock`, and on `unlock` it starts a
//! new capture session.

use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::RemoteDesktop::{
    WTSDisconnected, WTSFreeMemory, WTSQuerySessionInformationW, WTSSessionInfoEx, WTSINFOEXW,
    WTS_CURRENT_SERVER_HANDLE, WTS_CURRENT_SESSION,
};
use windows::Win32::System::StationsAndDesktops::{
    CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_CONTROL_FLAGS,
    DESKTOP_READOBJECTS, UOI_NAME,
};

/// `WTS_SESSIONSTATE_LOCK` in `WTSINFOEX_LEVEL1_W.SessionFlags` (the meaning is reversed only on
/// Windows 7 and Server 2008 R2, which Voice doesn't run on).
const SESSION_LOCKED: i32 = 0;

/// Locked, disconnected, or showing another desktop than `Default` (the lock screen's
/// `Winlogon`, a UAC prompt).
pub fn locked() -> bool {
    session_locked().unwrap_or(false) || input_desktop().is_some_and(|name| name != "Default")
}

fn session_locked() -> Option<bool> {
    let mut buffer = windows::core::PWSTR::null();
    let mut len = 0u32;
    unsafe {
        WTSQuerySessionInformationW(
            Some(WTS_CURRENT_SERVER_HANDLE),
            WTS_CURRENT_SESSION,
            WTSSessionInfoEx,
            &mut buffer,
            &mut len,
        )
        .ok()?;
        let result = if (len as usize) >= size_of::<WTSINFOEXW>() && !buffer.is_null() {
            let info = &*(buffer.0 as *const WTSINFOEXW);
            if info.Level == 1 {
                let level = info.Data.WTSInfoExLevel1;
                Some(level.SessionFlags == SESSION_LOCKED || level.SessionState == WTSDisconnected)
            } else {
                None
            }
        } else {
            None
        };
        WTSFreeMemory(buffer.0.cast());
        result
    }
}

/// The input desktop's name. A process can't open the secure desktop, so failing to open it
/// counts as `Winlogon`.
fn input_desktop() -> Option<String> {
    unsafe {
        let Ok(desk) = OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS)
        else {
            return Some("Winlogon".into());
        };
        let mut name = [0u16; 64];
        let read = GetUserObjectInformationW(
            HANDLE(desk.0),
            UOI_NAME,
            Some(name.as_mut_ptr().cast()),
            (name.len() * 2) as u32,
            None,
        );
        let _ = CloseDesktop(desk);
        read.ok()?;
        let end = name.iter().position(|&c| c == 0).unwrap_or(name.len());
        Some(String::from_utf16_lossy(&name[..end]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Tests normally run on an unlocked desktop, this machine's console or a CI runner's; a
    /// service session without one only has to answer.
    #[test]
    fn an_unlocked_desktop_reads_as_unlocked() {
        if input_desktop().as_deref() == Some("Default") {
            assert_ne!(session_locked(), Some(true));
            assert!(!locked());
        } else {
            let _ = locked();
        }
    }
}
