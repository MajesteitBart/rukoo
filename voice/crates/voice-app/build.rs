// Every command voice/ui/API.md lists. Naming them gives each an `allow-<command>` permission, so the
// capabilities can give the pill only the pill_* commands and Settings only the settings_* ones.
const COMMANDS: &[&str] = &[
    "pill_snapshot",
    "pill_ack",
    "pill_layout",
    "settings_state",
    "settings_set",
    "settings_save_provider",
    "settings_remove_key",
    "settings_list_models",
    "settings_model",
    "settings_choose_folder",
    "settings_open_folder",
    "settings_open_link",
    "settings_clean_preview",
    "settings_check_updates",
    "settings_new_token",
    "settings_import_ownkey",
    "settings_sync_test",
    "settings_close",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("tauri-build failed");
}
