//! What the app reads from Windows before the engine answers: the theme and language to start in, and a
//! way to say why it can't start.

use voice_engine::Locale;

/// Windows' "app mode" setting. Missing means light, Windows' default.
#[cfg(windows)]
pub fn prefers_light_theme() -> bool {
    use windows::core::w;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};

    let mut value = 1u32;
    let mut size = std::mem::size_of::<u32>() as u32;
    let result = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"),
            w!("AppsUseLightTheme"),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut value as *mut u32 as *mut _),
            Some(&mut size),
        )
    };
    result.is_err() || value != 0
}

#[cfg(not(windows))]
pub fn prefers_light_theme() -> bool {
    true
}

/// Dutch when Windows' display language is Dutch, else English.
#[cfg(windows)]
pub fn locale() -> Locale {
    const LANG_DUTCH: u16 = 0x13;
    let language = unsafe { windows::Win32::Globalization::GetUserDefaultUILanguage() };
    if language & 0x3ff == LANG_DUTCH {
        Locale::Nl
    } else {
        Locale::En
    }
}

#[cfg(not(windows))]
pub fn locale() -> Locale {
    let lang = std::env::var("LANG").unwrap_or_default();
    if lang.starts_with("nl") {
        Locale::Nl
    } else {
        Locale::En
    }
}

/// Tells the user why Voice stops. A release build has no console, so it shows a dialog; a debug build
/// writes to stderr, so tests that start it never wait on a dialog.
pub fn fail(text: &str) {
    // Once logging runs, a debug build's log already echoes to stderr.
    if log::max_level() == log::LevelFilter::Off {
        eprintln!("{text}");
    }
    log::error!("{text}");
    #[cfg(all(windows, not(debug_assertions)))]
    unsafe {
        use windows::core::HSTRING;
        use windows::Win32::UI::WindowsAndMessaging::{
            MessageBoxW, MB_ICONERROR, MB_OK, MB_SETFOREGROUND,
        };
        MessageBoxW(
            None,
            &HSTRING::from(text),
            &HSTRING::from("Rukoo Voice"),
            MB_OK | MB_ICONERROR | MB_SETFOREGROUND,
        );
    }
}
