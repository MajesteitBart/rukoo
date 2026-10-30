//! "Where the file is" in PROTOCOL.md.
//!
//! The functions here are pure: they take the platform and the environment as arguments and
//! join with that platform's separator, so the fixtures for every platform run on any host.

use std::path::PathBuf;

use crate::Side;

/// The full path of the discovery file; both apps read it.
pub const BRIDGE_ENV: &str = "RUKOO_VOICE_BRIDGE";
/// Voice's data folder; only Voice reads it.
pub const DATA_DIR_ENV: &str = "RUKOO_VOICE_DATA_DIR";
/// Rukoo's profile folder; only Rukoo reads it.
pub const RUKOO_PROFILE_ENV: &str = "SEM_DATA_DIR";

/// The discovery file's name in Voice's data folder.
pub const BRIDGE_FILE: &str = "bridge.json";
/// The discovery file's name in a Rukoo profile set with `SEM_DATA_DIR`.
pub const RUKOO_PROFILE_BRIDGE_FILE: &str = "voice-bridge.json";

/// An operating system, for its default folders and path separator.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Platform {
    Windows,
    MacOs,
    Linux,
}

impl Platform {
    /// The system this program runs on. Unix systems other than macOS count as Linux.
    pub fn current() -> Platform {
        if cfg!(windows) {
            Platform::Windows
        } else if cfg!(target_os = "macos") {
            Platform::MacOs
        } else {
            Platform::Linux
        }
    }

    /// Reads Node's `process.platform` names, as the fixtures use them.
    pub fn parse(name: &str) -> Option<Platform> {
        match name {
            "win32" => Some(Platform::Windows),
            "darwin" => Some(Platform::MacOs),
            "linux" => Some(Platform::Linux),
            _ => None,
        }
    }

    fn separator(self) -> char {
        match self {
            Platform::Windows => '\\',
            Platform::MacOs | Platform::Linux => '/',
        }
    }

    fn is_separator(self, c: char) -> bool {
        match self {
            Platform::Windows => c == '\\' || c == '/',
            Platform::MacOs | Platform::Linux => c == '/',
        }
    }
}

/// The path of the discovery file as `side` works it out, or `None` when the environment lacks
/// the variable the default folder needs (`LOCALAPPDATA` or `HOME`).
///
/// `env` returns a variable's value; an empty value counts as unset.
pub fn bridge_path(
    side: Side,
    platform: Platform,
    env: &dyn Fn(&str) -> Option<String>,
) -> Option<String> {
    let var = |name: &str| env(name).filter(|value| !value.is_empty());
    if let Some(path) = var(BRIDGE_ENV) {
        return Some(path);
    }
    match side {
        Side::Voice => Some(join(platform, &voice_data_dir(platform, env)?, BRIDGE_FILE)),
        Side::Rukoo => match var(RUKOO_PROFILE_ENV) {
            Some(profile) => Some(join(platform, &profile, RUKOO_PROFILE_BRIDGE_FILE)),
            None => Some(join(
                platform,
                &default_data_dir(platform, env)?,
                BRIDGE_FILE,
            )),
        },
    }
}

/// [`bridge_path`] for the running system and its environment.
pub fn bridge_path_here(side: Side) -> Option<PathBuf> {
    bridge_path(side, Platform::current(), &process_env).map(PathBuf::from)
}

/// Voice's data folder: `RUKOO_VOICE_DATA_DIR` when set, otherwise the default folder.
pub fn voice_data_dir(platform: Platform, env: &dyn Fn(&str) -> Option<String>) -> Option<String> {
    match env(DATA_DIR_ENV).filter(|value| !value.is_empty()) {
        Some(dir) => Some(dir),
        None => default_data_dir(platform, env),
    }
}

/// [`voice_data_dir`] for the running system and its environment.
pub fn voice_data_dir_here() -> Option<PathBuf> {
    voice_data_dir(Platform::current(), &process_env).map(PathBuf::from)
}

/// The data folder of an installed Voice, which ignores `RUKOO_VOICE_DATA_DIR`.
fn default_data_dir(platform: Platform, env: &dyn Fn(&str) -> Option<String>) -> Option<String> {
    let var = |name: &str| env(name).filter(|value| !value.is_empty());
    match platform {
        Platform::Windows => Some(join(platform, &var("LOCALAPPDATA")?, "Rukoo Voice")),
        Platform::MacOs => Some(join(
            platform,
            &var("HOME")?,
            "Library/Application Support/Rukoo Voice",
        )),
        Platform::Linux => {
            let state = match var("XDG_STATE_HOME") {
                Some(state) => state,
                None => join(platform, &var("HOME")?, ".local/state"),
            };
            Some(join(platform, &state, "rukoo-voice"))
        }
    }
}

/// Joins `base` and a relative `tail` written with `/`, using the platform's separator.
fn join(platform: Platform, base: &str, tail: &str) -> String {
    let separator = platform.separator();
    let mut path = base.to_owned();
    for part in tail.split('/') {
        if !path.ends_with(|c| platform.is_separator(c)) {
            path.push(separator);
        }
        path.push_str(part);
    }
    path
}

fn process_env(name: &str) -> Option<String> {
    // A value that isn't Unicode can't be one of the paths above; treat it as unset.
    std::env::var(name).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn path(side: Side, platform: Platform, vars: &[(&str, &str)]) -> Option<String> {
        let vars: HashMap<String, String> = vars
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        bridge_path(side, platform, &|name| vars.get(name).cloned())
    }

    #[test]
    fn a_trailing_separator_is_not_doubled() {
        assert_eq!(
            path(
                Side::Voice,
                Platform::Windows,
                &[("RUKOO_VOICE_DATA_DIR", "D:\\")]
            )
            .unwrap(),
            "D:\\bridge.json"
        );
        assert_eq!(
            path(
                Side::Rukoo,
                Platform::Windows,
                &[("SEM_DATA_DIR", "E:/rukoo/profile/")]
            )
            .unwrap(),
            "E:/rukoo/profile/voice-bridge.json"
        );
        assert_eq!(
            path(Side::Voice, Platform::Linux, &[("HOME", "/home/anna/")]).unwrap(),
            "/home/anna/.local/state/rukoo-voice/bridge.json"
        );
    }

    #[test]
    fn no_default_folder_without_its_variable() {
        assert_eq!(
            path(Side::Voice, Platform::Windows, &[("HOME", "C:\\x")]),
            None
        );
        assert_eq!(path(Side::Rukoo, Platform::Linux, &[("HOME", "")]), None);
        assert_eq!(
            path(
                Side::Rukoo,
                Platform::Linux,
                &[("RUKOO_VOICE_BRIDGE", "/tmp/b.json")]
            )
            .unwrap(),
            "/tmp/b.json"
        );
    }

    #[test]
    fn data_folder_follows_the_variable() {
        let env = |name: &str| (name == "RUKOO_VOICE_DATA_DIR").then(|| "/dev/voice".to_owned());
        assert_eq!(voice_data_dir(Platform::Linux, &env).unwrap(), "/dev/voice");
        let env = |name: &str| (name == "HOME").then(|| "/Users/anna".to_owned());
        assert_eq!(
            voice_data_dir(Platform::MacOs, &env).unwrap(),
            "/Users/anna/Library/Application Support/Rukoo Voice"
        );
    }

    #[test]
    fn platform_names() {
        assert_eq!(Platform::parse("win32"), Some(Platform::Windows));
        assert_eq!(Platform::parse("darwin"), Some(Platform::MacOs));
        assert_eq!(Platform::parse("linux"), Some(Platform::Linux));
        assert_eq!(Platform::parse("aix"), None);
    }
}
