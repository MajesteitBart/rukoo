//! Keeps the app's command lists in step without starting Tauri. A command in the handler but not
//! in build.rs's COMMANDS list has no `allow-<command>` permission, and Tauri's ACL rejects the
//! page's invoke before Voice runs it. That is how `settings_open_permission` stayed broken while
//! every Open button in Settings > Permissions failed.
//!
//! The test reads the sources as text: `src/commands.rs` for `generate_handler!`, `build.rs` for
//! the list that generates the permissions, the capability files for what each page may call, and
//! the pages for what they invoke. It runs on macOS, the build with every command: the macOS-only
//! one carries a `#[cfg]` in the handler, sits in build.rs's `MACOS_COMMANDS` and is allowed in
//! `capabilities/settings-macos.json`.

#![cfg(target_os = "macos")]

use std::collections::BTreeSet;
use std::path::Path;

const MANIFEST: &str = env!("CARGO_MANIFEST_DIR");

fn between<'a>(text: &'a str, start: &str, end: &str) -> &'a str {
    let from = text
        .find(start)
        .unwrap_or_else(|| panic!("no {start:?} in the source"));
    let rest = &text[from + start.len()..];
    let to = rest
        .find(end)
        .unwrap_or_else(|| panic!("no {end:?} after {start:?}"));
    &rest[..to]
}

fn handler_commands() -> BTreeSet<String> {
    let source = std::fs::read_to_string(Path::new(MANIFEST).join("src/commands.rs")).unwrap();
    between(&source, "tauri::generate_handler![", "\n    ]")
        .split(',')
        // A macOS-only entry is `#[cfg(target_os = "macos")] name`; the attribute holds no comma.
        .map(|entry| match entry.rfind(']') {
            Some(at) => &entry[at + 1..],
            None => entry,
        })
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .collect()
}

fn build_commands() -> BTreeSet<String> {
    let source = std::fs::read_to_string(Path::new(MANIFEST).join("build.rs")).unwrap();
    let names = |list: &str| {
        list.split('"')
            .skip(1)
            .step_by(2)
            .map(str::to_string)
            .collect::<Vec<_>>()
    };
    let mut commands: BTreeSet<String> =
        names(between(&source, "const COMMANDS: &[&str] = &[", "];"))
            .into_iter()
            .collect();
    commands.extend(names(between(
        &source,
        "const MACOS_COMMANDS: &[&str] = &[",
        "];",
    )));
    commands
}

/// The `allow-*` entries of a capability file, as command names. Tauri writes an underscore as a
/// hyphen, so `allow-settings-open-permission` is the permission for `settings_open_permission`.
fn capability_commands(file: &str) -> BTreeSet<String> {
    let text =
        std::fs::read_to_string(Path::new(MANIFEST).join("capabilities").join(file)).unwrap();
    let json: serde_json::Value = serde_json::from_str(&text).unwrap();
    json["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|permission| permission.as_str())
        .filter_map(|permission| permission.strip_prefix("allow-"))
        .map(|command| command.replace('-', "_"))
        .collect()
}

/// Every `invoke('command')` in a page.
fn page_commands(file: &str) -> BTreeSet<String> {
    let source = std::fs::read_to_string(Path::new(MANIFEST).join("../..").join(file)).unwrap();
    assert_eq!(
        source.matches("invoke(").count(),
        source.matches("invoke('").count(),
        "{file}: every invoke must name its command as a literal for this test to see it"
    );
    let mut found = BTreeSet::new();
    let mut rest = source.as_str();
    while let Some(at) = rest.find("invoke('") {
        rest = &rest[at + "invoke('".len()..];
        let end = rest.find('\'').expect("unterminated invoke('");
        found.insert(rest[..end].to_string());
        rest = &rest[end..];
    }
    found
}

#[test]
fn every_command_the_pages_invoke_is_registered_and_allowed() {
    let handler = handler_commands();
    let build = build_commands();
    assert_eq!(
        build, handler,
        "build.rs's COMMANDS and generate_handler! disagree"
    );

    let mut invoked = page_commands("ui/settings.js");
    invoked.extend(page_commands("ui/pill.js"));
    assert_eq!(
        invoked, handler,
        "the pages invoke commands that generate_handler! doesn't register"
    );

    let mut settings = capability_commands("settings.json");
    settings.extend(capability_commands("settings-macos.json"));
    let pill = capability_commands("pill.json");
    for command in &handler {
        let allowed = if command.starts_with("pill_") {
            &pill
        } else {
            &settings
        };
        assert!(
            allowed.contains(command),
            "{command} has no allow- entry in its page's capability"
        );
    }
    for (page, allowed) in [("settings", &settings), ("pill", &pill)] {
        for command in allowed {
            assert!(
                handler.contains(command),
                "{page}.json allows {command}, which generate_handler! doesn't register"
            );
        }
    }
}
