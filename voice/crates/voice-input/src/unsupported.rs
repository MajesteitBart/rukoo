//! Other platforms: no hotkeys or insertion yet. Every call says so instead
//! of failing silently.

use std::time::Duration;

use crate::target::WindowInfo;
use crate::{InputError, Key};

pub(crate) fn key_state() -> Result<fn(Key) -> bool, InputError> {
    Err(InputError::Unsupported)
}

pub(crate) fn is_key_down(_key: Key) -> bool {
    false
}

pub(crate) fn type_text(_text: &str) -> Result<(), InputError> {
    Err(InputError::Unsupported)
}

pub(crate) fn paste_text(_text: &str) -> Result<(), InputError> {
    Err(InputError::Unsupported)
}

pub(crate) fn capture_selection(_timeout: Duration) -> Result<Option<String>, InputError> {
    Err(InputError::Unsupported)
}

pub(crate) fn wait_for_clipboard_restore() {}

pub(crate) fn foreground_window() -> Option<WindowInfo> {
    None
}
