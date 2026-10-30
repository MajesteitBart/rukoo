//! Start at login: the HKCU Run value `Rukoo Voice` (decision 6).
//!
//! Differs from Ownkey on purpose (ownkey-dictation.md 17.3): Ownkey re-registered itself on
//! every launch, so turning it off never stuck, and a source run overwrote the installed copy's
//! value. Voice writes the value only while the setting is on, registers an installed copy once
//! on its first start, and never touches it in development mode. The engine enforces the last
//! two; this module only reads and writes the value.

use crate::services::Autostart;

pub const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
pub const VALUE_NAME: &str = "Rukoo Voice";

/// The Run value for one command line.
pub struct RunValue {
    command: String,
}

impl RunValue {
    /// The running app, quoted, as the Run value's command.
    pub fn for_current_exe() -> RunValue {
        let exe = std::env::current_exe().unwrap_or_default();
        RunValue {
            command: quoted(&exe.display().to_string()),
        }
    }

    pub fn command(&self) -> &str {
        &self.command
    }
}

pub fn quoted(path: &str) -> String {
    format!("\"{path}\"")
}

#[cfg(windows)]
impl Autostart for RunValue {
    fn is_on(&self) -> bool {
        use windows::core::HSTRING;
        use windows::Win32::Foundation::ERROR_SUCCESS;
        use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                &HSTRING::from(RUN_KEY),
                &HSTRING::from(VALUE_NAME),
                RRF_RT_REG_SZ,
                None,
                None,
                None,
            )
        };
        status == ERROR_SUCCESS
    }

    fn set(&self, on: bool) -> Result<(), String> {
        use windows::core::HSTRING;
        use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
        use windows::Win32::System::Registry::{
            RegDeleteKeyValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ,
        };
        let status = if on {
            let wide: Vec<u16> = self
                .command
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();
            unsafe {
                RegSetKeyValueW(
                    HKEY_CURRENT_USER,
                    &HSTRING::from(RUN_KEY),
                    &HSTRING::from(VALUE_NAME),
                    REG_SZ.0,
                    Some(wide.as_ptr().cast()),
                    (wide.len() * 2) as u32,
                )
            }
        } else {
            let status = unsafe {
                RegDeleteKeyValueW(
                    HKEY_CURRENT_USER,
                    &HSTRING::from(RUN_KEY),
                    &HSTRING::from(VALUE_NAME),
                )
            };
            // Already off.
            if status == ERROR_FILE_NOT_FOUND {
                ERROR_SUCCESS
            } else {
                status
            }
        };
        if status == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(format!(
                "Windows refused to change Start at login (error {}).",
                status.0
            ))
        }
    }
}

#[cfg(not(windows))]
impl Autostart for RunValue {
    fn is_on(&self) -> bool {
        false
    }

    fn set(&self, _on: bool) -> Result<(), String> {
        Err("Start at login isn't supported on this platform yet.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_command_is_the_quoted_exe() {
        assert_eq!(
            quoted("C:\\Program Files\\Rukoo Voice\\rukoo-voice.exe"),
            "\"C:\\Program Files\\Rukoo Voice\\rukoo-voice.exe\""
        );
        assert!(RunValue::for_current_exe().command().starts_with('"'));
    }
}
