//! The inputs of `voice_screen_files::monitors::choose` from Windows: the monitors, the
//! top-level windows in Z-order and the cursor. Window titles are never read.

use std::collections::HashMap;

use voice_screen_files::monitors::{MonitorInfo, WindowInfo};
use windows::core::BOOL;
use windows::Win32::Devices::Display::{
    DisplayConfigGetDeviceInfo, GetDisplayConfigBufferSizes, QueryDisplayConfig,
    DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME, DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME,
    DISPLAYCONFIG_MODE_INFO, DISPLAYCONFIG_PATH_INFO, DISPLAYCONFIG_SOURCE_DEVICE_NAME,
    DISPLAYCONFIG_TARGET_DEVICE_NAME, QDC_ONLY_ACTIVE_PATHS,
};
use windows::Win32::Foundation::{ERROR_SUCCESS, HWND, LPARAM, POINT, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, MonitorFromPoint, MonitorFromWindow, HDC, HMONITOR,
    MONITORINFO, MONITORINFOEXW, MONITOR_DEFAULTTONEAREST, MONITOR_DEFAULTTONULL,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetClassNameW, GetCursorPos, GetForegroundWindow, GetWindow, GetWindowDisplayAffinity,
    GetWindowLongW, IsIconic, IsWindowVisible, GWL_EXSTYLE, GW_HWNDNEXT, MONITORINFOF_PRIMARY,
    WS_EX_TOOLWINDOW,
};

/// Every monitor, in the order Windows enumerates them. Rectangles are physical pixels, since
/// the process is per-monitor DPI aware.
pub fn list() -> Vec<MonitorInfo> {
    let mut handles: Vec<HMONITOR> = Vec::new();
    unsafe extern "system" fn add(monitor: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> BOOL {
        let list = unsafe { &mut *(data.0 as *mut Vec<HMONITOR>) };
        list.push(monitor);
        BOOL(1)
    }
    unsafe {
        let _ = EnumDisplayMonitors(
            None,
            None,
            Some(add),
            LPARAM(&mut handles as *mut Vec<HMONITOR> as isize),
        );
    }
    let names = friendly_names();
    let mut out: Vec<MonitorInfo> = handles
        .into_iter()
        .filter_map(|h| info(h, &names))
        .collect();
    out.dedup_by(|a, b| a.id == b.id);
    out
}

fn info(monitor: HMONITOR, names: &HashMap<String, String>) -> Option<MonitorInfo> {
    let mut mi = MONITORINFOEXW::default();
    mi.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
    if !unsafe { GetMonitorInfoW(monitor, &mut mi as *mut MONITORINFOEXW as *mut MONITORINFO) }
        .as_bool()
    {
        return None;
    }
    let id = utf16(&mi.szDevice);
    if id.is_empty() {
        return None;
    }
    let r = mi.monitorInfo.rcMonitor;
    let name = names.get(&id).cloned().unwrap_or_else(|| {
        let n: String = id
            .chars()
            .rev()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        let n: String = n.chars().rev().collect();
        if n.is_empty() {
            "Display".into()
        } else {
            format!("Display {n}")
        }
    });
    Some(MonitorInfo {
        id,
        name,
        x: r.left,
        y: r.top,
        width: (r.right - r.left).max(0) as u32,
        height: (r.bottom - r.top).max(0) as u32,
        primary: mi.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
    })
}

fn utf16(text: &[u16]) -> String {
    let end = text.iter().position(|&c| c == 0).unwrap_or(text.len());
    String::from_utf16_lossy(&text[..end])
}

/// `\\.\DISPLAY1` → the monitor's friendly name, such as "DELL S3220DGF".
fn friendly_names() -> HashMap<String, String> {
    let mut names = HashMap::new();
    let (mut paths_len, mut modes_len) = (0u32, 0u32);
    unsafe {
        if GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut paths_len, &mut modes_len)
            != ERROR_SUCCESS
        {
            return names;
        }
        let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); paths_len as usize];
        let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); modes_len as usize];
        if QueryDisplayConfig(
            QDC_ONLY_ACTIVE_PATHS,
            &mut paths_len,
            paths.as_mut_ptr(),
            &mut modes_len,
            modes.as_mut_ptr(),
            None,
        ) != ERROR_SUCCESS
        {
            return names;
        }
        for path in &paths[..paths_len as usize] {
            let mut source = DISPLAYCONFIG_SOURCE_DEVICE_NAME::default();
            source.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME;
            source.header.size = size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32;
            source.header.adapterId = path.sourceInfo.adapterId;
            source.header.id = path.sourceInfo.id;
            if DisplayConfigGetDeviceInfo(&mut source.header) != 0 {
                continue;
            }
            let mut target = DISPLAYCONFIG_TARGET_DEVICE_NAME::default();
            target.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME;
            target.header.size = size_of::<DISPLAYCONFIG_TARGET_DEVICE_NAME>() as u32;
            target.header.adapterId = path.targetInfo.adapterId;
            target.header.id = path.targetInfo.id;
            if DisplayConfigGetDeviceInfo(&mut target.header) != 0 {
                continue;
            }
            let friendly = utf16(&target.monitorFriendlyDeviceName);
            if !friendly.is_empty() {
                names.insert(utf16(&source.viewGdiDeviceName), friendly);
            }
        }
    }
    names
}

fn monitor_id(monitor: HMONITOR) -> Option<String> {
    if monitor.is_invalid() {
        return None;
    }
    let mut mi = MONITORINFOEXW::default();
    mi.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
    unsafe { GetMonitorInfoW(monitor, &mut mi as *mut MONITORINFOEXW as *mut MONITORINFO) }
        .as_bool()
        .then(|| utf16(&mi.szDevice))
        .filter(|id| !id.is_empty())
}

/// The monitor handle for an id, resolved now: handles don't survive display changes.
pub fn hmonitor(id: &str) -> Option<HMONITOR> {
    let mut handles: Vec<HMONITOR> = Vec::new();
    unsafe extern "system" fn add(monitor: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> BOOL {
        let list = unsafe { &mut *(data.0 as *mut Vec<HMONITOR>) };
        list.push(monitor);
        BOOL(1)
    }
    unsafe {
        let _ = EnumDisplayMonitors(
            None,
            None,
            Some(add),
            LPARAM(&mut handles as *mut Vec<HMONITOR> as isize),
        );
    }
    handles
        .into_iter()
        .find(|&h| monitor_id(h).as_deref() == Some(id))
}

/// The cursor's monitor.
pub fn cursor_monitor() -> Option<String> {
    let mut point = POINT::default();
    unsafe { GetCursorPos(&mut point) }.ok()?;
    monitor_id(unsafe { MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST) })
}

/// Top-level windows from the foreground window down the Z-order.
pub fn z_order() -> Vec<WindowInfo> {
    const MAX_WINDOWS: usize = 512;
    let mut out = Vec::new();
    let mut hwnd = unsafe { GetForegroundWindow() };
    while !hwnd.is_invalid() && out.len() < MAX_WINDOWS {
        if let Some(window) = window(hwnd) {
            out.push(window);
        }
        hwnd = match unsafe { GetWindow(hwnd, GW_HWNDNEXT) } {
            Ok(next) => next,
            Err(_) => break,
        };
    }
    out
}

fn window(hwnd: HWND) -> Option<WindowInfo> {
    let monitor = monitor_id(unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONULL) })?;
    let mut cloaked = 0u32;
    let cloaked = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as *mut _,
            size_of::<u32>() as u32,
        )
    }
    .is_ok()
        && cloaked != 0;
    let ex_style = unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) } as u32;
    let mut affinity = 0u32;
    let excluded =
        unsafe { GetWindowDisplayAffinity(hwnd, &mut affinity) }.is_ok() && affinity != 0;
    let mut class = [0u16; 64];
    let len = unsafe { GetClassNameW(hwnd, &mut class) }.max(0) as usize;
    let class = String::from_utf16_lossy(&class[..len.min(class.len())]);
    Some(WindowInfo {
        monitor,
        visible: unsafe { IsWindowVisible(hwnd) }.as_bool(),
        minimized: unsafe { IsIconic(hwnd) }.as_bool(),
        cloaked,
        tool: ex_style & WS_EX_TOOLWINDOW.0 != 0,
        shell: matches!(
            class.as_str(),
            "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd"
        ),
        excluded,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_monitors_with_ids_that_resolve() {
        crate::com::dpi_aware();
        let monitors = list();
        // CI runners have one virtual display; a session without one has none.
        for m in &monitors {
            assert!(m.id.starts_with(r"\\.\"), "{}", m.id);
            assert!(m.width > 0 && m.height > 0);
            assert!(hmonitor(&m.id).is_some(), "{}", m.id);
        }
        assert!(monitors.iter().filter(|m| m.primary).count() <= 1);
        assert!(hmonitor(r"\\.\NOPE9").is_none());
        let _ = z_order();
        let _ = cursor_monitor();
    }
}
