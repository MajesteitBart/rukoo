//! The hotkeys Voice offers, named as in Ownkey's config.

use std::fmt;
use std::str::FromStr;

/// A key that can start dictation or a rewrite.
///
/// The names are Ownkey's config strings (`"right alt"`, `"f13"`, ...), so an
/// imported Ownkey config keeps its keys. Only the left/right-specific virtual
/// keys tell the right-hand modifiers apart from the left ones.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Key {
    /// Also AltGr on international layouts.
    RightAlt,
    RightCtrl,
    RightShift,
    F13,
    F14,
    F15,
    Pause,
    ScrollLock,
}

impl Key {
    /// Every offered key, in Ownkey's order. Poll all of them: which mode a key
    /// means is decided per event, so a Settings change never needs a new poller.
    pub const ALL: [Key; 8] = [
        Key::RightAlt,
        Key::RightCtrl,
        Key::RightShift,
        Key::F13,
        Key::F14,
        Key::F15,
        Key::Pause,
        Key::ScrollLock,
    ];

    /// The config and display name, for example `"right alt"`.
    pub fn name(self) -> &'static str {
        match self {
            Key::RightAlt => "right alt",
            Key::RightCtrl => "right ctrl",
            Key::RightShift => "right shift",
            Key::F13 => "f13",
            Key::F14 => "f14",
            Key::F15 => "f15",
            Key::Pause => "pause",
            Key::ScrollLock => "scroll lock",
        }
    }

    /// Parses a config name. Surrounding whitespace and case are ignored, as in
    /// Ownkey's `sanitize_hotkey`. Falling back to a default is the caller's job.
    pub fn parse(name: &str) -> Option<Key> {
        let name = name.trim().to_lowercase();
        Key::ALL.into_iter().find(|key| key.name() == name)
    }

    /// The Windows virtual-key code.
    pub fn vk(self) -> u16 {
        match self {
            Key::RightAlt => 0xA5,   // VK_RMENU
            Key::RightCtrl => 0xA3,  // VK_RCONTROL
            Key::RightShift => 0xA1, // VK_RSHIFT
            Key::F13 => 0x7C,
            Key::F14 => 0x7D,
            Key::F15 => 0x7E,
            Key::Pause => 0x13,
            Key::ScrollLock => 0x91,
        }
    }

    /// Whether the selection can be copied while this key is held.
    ///
    /// Ownkey captures the selection at press for these keys, because racing
    /// the capture against the release is far less reliable. Holding Right Alt
    /// or Right Shift while Ctrl+C is sent would make it Ctrl+Alt+C or
    /// Ctrl+Shift+C, so those wait for the release.
    pub fn can_copy_while_held(self) -> bool {
        !matches!(self, Key::RightAlt | Key::RightShift)
    }
}

impl fmt::Display for Key {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

/// The name didn't match any offered key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnknownKey(pub String);

impl fmt::Display for UnknownKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "unknown hotkey {:?}", self.0)
    }
}

impl std::error::Error for UnknownKey {}

impl FromStr for Key {
    type Err = UnknownKey;

    fn from_str(name: &str) -> Result<Key, UnknownKey> {
        Key::parse(name).ok_or_else(|| UnknownKey(name.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Ownkey's HOTKEY_VKS (windows_hotkeys.py:12-21), which a test there keeps
    // equal to HOTKEY_LIST.
    const OWNKEY: [(&str, u16); 8] = [
        ("right alt", 0xA5),
        ("right ctrl", 0xA3),
        ("right shift", 0xA1),
        ("f13", 0x7C),
        ("f14", 0x7D),
        ("f15", 0x7E),
        ("pause", 0x13),
        ("scroll lock", 0x91),
    ];

    #[test]
    fn offers_exactly_ownkeys_keys_and_codes() {
        let ours: Vec<(&str, u16)> = Key::ALL.iter().map(|k| (k.name(), k.vk())).collect();
        assert_eq!(ours, OWNKEY);
    }

    #[test]
    fn names_round_trip() {
        for key in Key::ALL {
            assert_eq!(Key::parse(key.name()), Some(key));
            assert_eq!(key.to_string().parse::<Key>(), Ok(key));
        }
    }

    #[test]
    fn parse_ignores_case_and_surrounding_space() {
        assert_eq!(Key::parse("  Right Alt "), Some(Key::RightAlt));
        assert_eq!(Key::parse("SCROLL LOCK"), Some(Key::ScrollLock));
    }

    #[test]
    fn parse_rejects_unknown_names() {
        assert_eq!(Key::parse(""), None);
        assert_eq!(Key::parse("off"), None);
        assert_eq!(Key::parse("rightalt"), None);
        assert_eq!(Key::parse("f16"), None);
        assert_eq!(
            "left alt".parse::<Key>(),
            Err(UnknownKey("left alt".into()))
        );
    }

    #[test]
    fn copy_while_held_matches_ownkeys_press_capture_keys() {
        // REWRITE_PRESS_CAPTURE_HOTKEYS, ownkey.py:195-199.
        let press_capture: Vec<&str> = Key::ALL
            .into_iter()
            .filter(|k| k.can_copy_while_held())
            .map(Key::name)
            .collect();
        assert_eq!(
            press_capture,
            ["right ctrl", "f13", "f14", "f15", "pause", "scroll lock"]
        );
    }
}
