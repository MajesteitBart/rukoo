//! Per-thread COM setup. Every thread that touches Direct3D, Media Foundation or WinRT joins the
//! multithreaded apartment; WinRT's async calls then block with `join()`.

use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::Win32::UI::HiDpi::{
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};

/// Joins the multithreaded apartment. Calling it again on the same thread is harmless.
pub fn init_mta() {
    // S_FALSE when the thread is in the MTA already; RPC_E_CHANGED_MODE can't happen on the
    // threads this process makes.
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
}

/// Monitor rectangles and capture sizes in physical pixels, whatever the scaling.
pub fn dpi_aware() {
    let _ = unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
}
