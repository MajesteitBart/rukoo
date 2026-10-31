//! The real system: the ready chime, the Windows theme and language, Ownkey's process and free
//! disk space. Windows only in 0.1; elsewhere these answer quietly with defaults.

use std::path::Path;
use std::time::Duration;

use crate::api::{Locale, Theme};
use crate::services::{Chime, System};

/// Ownkey keeps chimes at least this far apart (`ownkey.py:268`).
pub const CHIME_COOLDOWN: Duration = Duration::from_millis(200);

pub struct SystemChime;

impl Chime for SystemChime {
    #[cfg(windows)]
    fn play(&self) {
        use windows::core::w;
        use windows::Win32::Media::Audio::{PlaySoundW, SND_ALIAS, SND_ASYNC, SND_NODEFAULT};
        use windows::Win32::System::Diagnostics::Debug::MessageBeep;
        use windows::Win32::UI::WindowsAndMessaging::MB_OK;
        // The user's "Asterisk" sound, without the default beep when the alias has none.
        let played = unsafe {
            PlaySoundW(
                w!("SystemAsterisk"),
                None,
                SND_ALIAS | SND_ASYNC | SND_NODEFAULT,
            )
        };
        if !played.as_bool() {
            let _ = unsafe { MessageBeep(MB_OK) };
        }
    }

    #[cfg(not(windows))]
    fn play(&self) {}
}

pub struct SystemInfo;

impl System for SystemInfo {
    fn theme(&self) -> Theme {
        #[cfg(windows)]
        {
            // 0 means the user chose dark mode for apps.
            match win::read_dword(
                "Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
                "AppsUseLightTheme",
            ) {
                Some(0) => Theme::Dark,
                Some(_) => Theme::Light,
                None => Theme::Light,
            }
        }
        #[cfg(not(windows))]
        Theme::Light
    }

    fn locale(&self) -> Locale {
        #[cfg(windows)]
        {
            const LANG_DUTCH: u16 = 0x13;
            let language = unsafe { windows::Win32::Globalization::GetUserDefaultUILanguage() };
            if language & 0x3ff == LANG_DUTCH {
                return Locale::Nl;
            }
            Locale::En
        }
        #[cfg(not(windows))]
        {
            let lang = std::env::var("LANG").unwrap_or_default();
            if lang.starts_with("nl") {
                Locale::Nl
            } else {
                Locale::En
            }
        }
    }

    fn ownkey_running(&self) -> bool {
        #[cfg(windows)]
        {
            win::process_running("ownkey.exe")
        }
        #[cfg(not(windows))]
        false
    }

    fn free_bytes(&self, path: &Path) -> Option<u64> {
        #[cfg(windows)]
        {
            win::free_bytes(path)
        }
        #[cfg(not(windows))]
        {
            let _ = path;
            None
        }
    }
}

#[cfg(windows)]
pub(crate) mod win {
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::Foundation::{CloseHandle, ERROR_SUCCESS};
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};

    pub fn read_dword(key: &str, value: &str) -> Option<u32> {
        let mut data = 0u32;
        let mut size = std::mem::size_of::<u32>() as u32;
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                &HSTRING::from(key),
                &HSTRING::from(value),
                RRF_RT_REG_DWORD,
                None,
                Some(std::ptr::from_mut(&mut data).cast()),
                Some(&mut size),
            )
        };
        (status == ERROR_SUCCESS).then_some(data)
    }

    /// Reads the process list only; Voice never stops Ownkey.
    pub fn process_running(image: &str) -> bool {
        let Ok(snapshot) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
            return false;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut found = false;
        let mut more = unsafe { Process32FirstW(snapshot, &mut entry) }.is_ok();
        while more {
            let len = entry
                .szExeFile
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
            if name.eq_ignore_ascii_case(image) {
                found = true;
                break;
            }
            more = unsafe { Process32NextW(snapshot, &mut entry) }.is_ok();
        }
        let _ = unsafe { CloseHandle(snapshot) };
        found
    }

    pub fn free_bytes(path: &Path) -> Option<u64> {
        // The folder may not exist yet; its drive is what counts.
        let mut existing = path;
        while !existing.exists() {
            existing = existing.parent()?;
        }
        let wide: Vec<u16> = existing
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let mut available = 0u64;
        unsafe {
            GetDiskFreeSpaceExW(PCWSTR(wide.as_ptr()), Some(&mut available), None, None).ok()?;
        }
        Some(available)
    }
}
