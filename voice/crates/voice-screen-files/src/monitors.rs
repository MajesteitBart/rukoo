//! Which monitor to record. Pure; the Windows side gathers the inputs.

use serde::{Deserialize, Serialize};

/// A monitor. `id` is `MONITORINFOEXW.szDevice`, such as `\\.\DISPLAY1`; `x` and `y` are its
/// top-left corner on the virtual desktop.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    pub id: String,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub primary: bool,
}

/// A top-level window, in Z-order from the foreground window down.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WindowInfo {
    /// The id of the monitor it is on.
    pub monitor: String,
    pub visible: bool,
    pub minimized: bool,
    pub cloaked: bool,
    /// `WS_EX_TOOLWINDOW`.
    pub tool: bool,
    /// A shell window: `Progman`, `WorkerW`, `Shell_TrayWnd`, `Shell_SecondaryTrayWnd`.
    pub shell: bool,
    /// Excluded from capture (`GetWindowDisplayAffinity != WDA_NONE`).
    pub excluded: bool,
}

/// The monitor of the topmost window that is visible, not minimized, not cloaked, not a tool or
/// shell window and not excluded from capture; else the cursor's monitor; else the primary.
pub fn choose(
    z_order: &[WindowInfo],
    cursor: Option<&str>,
    monitors: &[MonitorInfo],
) -> Option<String> {
    let _ = (z_order, cursor, monitors);
    todo!()
}

/// The monitor after `current`, left to right, wrapping.
pub fn next(monitors: &[MonitorInfo], current: &str) -> Option<String> {
    let _ = (monitors, current);
    todo!()
}

/// Left to right: by `x`, then `y`.
pub fn ordered(monitors: &[MonitorInfo]) -> Vec<MonitorInfo> {
    let _ = monitors;
    todo!()
}
