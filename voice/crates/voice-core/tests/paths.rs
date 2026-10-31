//! Path rules for every platform, checked on any host with a fake environment.

use std::collections::HashMap;
use std::path::Path;

use voice_core::paths::{
    config_file, data_dir_in, dev_mode_in, models_dir, ownkey_config_in, ownkey_models_in, Platform,
};

fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
    let map: HashMap<String, String> = pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    move |name: &str| map.get(name).cloned()
}

#[test]
fn data_folder_per_platform() {
    let windows = env(&[
        ("LOCALAPPDATA", "C:\\Users\\me\\AppData\\Local"),
        ("USERPROFILE", "C:\\Users\\me"),
    ]);
    assert_eq!(
        data_dir_in(Platform::Windows, &windows).unwrap(),
        "C:\\Users\\me\\AppData\\Local\\Rukoo Voice"
    );
    let no_local = env(&[("USERPROFILE", "C:\\Users\\me")]);
    assert_eq!(
        data_dir_in(Platform::Windows, &no_local).unwrap(),
        "C:\\Users\\me\\AppData\\Local\\Rukoo Voice"
    );
    let mac = env(&[("HOME", "/Users/me")]);
    assert_eq!(
        data_dir_in(Platform::MacOs, &mac).unwrap(),
        "/Users/me/Library/Application Support/Rukoo Voice"
    );
    let linux = env(&[("HOME", "/home/me")]);
    assert_eq!(
        data_dir_in(Platform::Linux, &linux).unwrap(),
        "/home/me/.local/state/rukoo-voice"
    );
    let xdg = env(&[("HOME", "/home/me"), ("XDG_STATE_HOME", "/state/")]);
    assert_eq!(
        data_dir_in(Platform::Linux, &xdg).unwrap(),
        "/state/rukoo-voice"
    );
    assert_eq!(data_dir_in(Platform::Linux, &env(&[])), None);
}

#[test]
fn the_data_dir_variable_means_development_mode() {
    let dev = env(&[
        ("RUKOO_VOICE_DATA_DIR", "E:\\dev\\voice"),
        ("LOCALAPPDATA", "C:\\x"),
    ]);
    assert_eq!(
        data_dir_in(Platform::Windows, &dev).unwrap(),
        "E:\\dev\\voice"
    );
    assert!(dev_mode_in(&dev));
    // An empty variable counts as unset.
    let empty = env(&[("RUKOO_VOICE_DATA_DIR", ""), ("LOCALAPPDATA", "C:\\x")]);
    assert_eq!(
        data_dir_in(Platform::Windows, &empty).unwrap(),
        "C:\\x\\Rukoo Voice"
    );
    assert!(!dev_mode_in(&empty));
}

#[test]
fn ownkey_locations() {
    let windows = env(&[
        ("APPDATA", "C:\\Users\\me\\AppData\\Roaming"),
        ("LOCALAPPDATA", "C:\\Users\\me\\AppData\\Local"),
    ]);
    assert_eq!(
        ownkey_config_in(Platform::Windows, &windows).unwrap(),
        "C:\\Users\\me\\AppData\\Roaming\\Ownkey\\config.json"
    );
    assert_eq!(
        ownkey_models_in(Platform::Windows, &windows).unwrap(),
        "C:\\Users\\me\\AppData\\Local\\Ownkey\\models"
    );
    let home_only = env(&[("USERPROFILE", "C:\\Users\\me")]);
    assert_eq!(
        ownkey_config_in(Platform::Windows, &home_only).unwrap(),
        "C:\\Users\\me\\Ownkey\\config.json"
    );
    assert_eq!(
        ownkey_models_in(Platform::Windows, &home_only).unwrap(),
        "C:\\Users\\me\\AppData\\Local\\Ownkey\\models"
    );
    let linux = env(&[("HOME", "/home/me")]);
    assert_eq!(
        ownkey_config_in(Platform::Linux, &linux).unwrap(),
        "/home/me/.config/ownkey/config.json"
    );
    assert_eq!(
        ownkey_models_in(Platform::Linux, &linux).unwrap(),
        "/home/me/.cache/ownkey/models"
    );
    let xdg = env(&[("XDG_CONFIG_HOME", "/cfg"), ("XDG_CACHE_HOME", "/cache")]);
    assert_eq!(
        ownkey_config_in(Platform::Linux, &xdg).unwrap(),
        "/cfg/ownkey/config.json"
    );
    assert_eq!(
        ownkey_models_in(Platform::Linux, &xdg).unwrap(),
        "/cache/ownkey/models"
    );
    assert_eq!(
        ownkey_config_in(Platform::MacOs, &env(&[("HOME", "/Users/me")])),
        None
    );
}

#[test]
fn files_in_the_data_folder() {
    let data = Path::new("data");
    assert_eq!(config_file(data), data.join("config.json"));
    assert_eq!(models_dir(data), data.join("models"));
}
