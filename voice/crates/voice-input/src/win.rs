//! The Windows backend: key state, SendInput, the clipboard and the focus.

use std::mem::size_of;
use std::thread;
use std::time::{Duration, Instant};

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData,
    GetClipboardFormatNameW, GetClipboardSequenceNumber, OpenClipboard, RegisterClipboardFormatW,
    SetClipboardData,
};
use windows::Win32::System::Memory::{
    GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE, GMEM_ZEROINIT,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT,
    KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MAPVK_VK_TO_VSC, VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DestroyWindow, GetClassNameW, GetForegroundWindow, GetGUIThreadInfo,
    GetWindowThreadProcessId, GUITHREADINFO, HWND_MESSAGE, WINDOW_EX_STYLE, WINDOW_STYLE,
};

use crate::clipboard::{self, format, Clipboard, Format, Gate, Keyboard, Snapshot, SystemClock};
use crate::strokes::{self, Stroke};
use crate::target::{classify, WindowInfo};
use crate::{InputError, Key};

/// Ownkey's pause between typed characters.
const TYPE_PACE: Duration = Duration::from_millis(5);
/// pyperclip, which Ownkey used, retried OpenClipboard every 10 ms for 0.5 s.
const OPEN_TIMEOUT: Duration = Duration::from_millis(500);
const OPEN_RETRY: Duration = Duration::from_millis(10);

static CLIPBOARD_GATE: Gate = Gate::new();

pub(crate) fn key_state() -> Result<fn(Key) -> bool, InputError> {
    Ok(is_key_down)
}

pub(crate) fn is_key_down(key: Key) -> bool {
    // Only the high bit, "down right now". The low bit, "pressed since the
    // last call", is shared with every other caller and unreliable.
    let state = unsafe { GetAsyncKeyState(i32::from(key.vk())) };
    state as u16 & 0x8000 != 0
}

pub(crate) fn type_text(text: &str) -> Result<(), InputError> {
    for batch in strokes::typing(text) {
        SendKeys.send(&batch)?;
        thread::sleep(TYPE_PACE);
    }
    Ok(())
}

pub(crate) fn paste_text(text: &str) -> Result<(), InputError> {
    let turn = CLIPBOARD_GATE.enter();
    let pending = clipboard::paste(text, &mut WinClipboard, &mut SendKeys, &SystemClock::new())?;
    // Restoring on another thread lets the caller report the insertion now.
    // The turn moves along, so the next paste or capture waits for it. If the
    // thread can't start or the restore fails, our text stays on the
    // clipboard, which is what Ownkey always did.
    let _ = thread::Builder::new()
        .name("clipboard-restore".into())
        .spawn(move || {
            thread::sleep(clipboard::RESTORE_AFTER);
            let _ = clipboard::restore_if_unchanged(&mut WinClipboard, &pending);
            drop(turn);
        });
    Ok(())
}

pub(crate) fn capture_selection(timeout: Duration) -> Result<Option<String>, InputError> {
    let _turn = CLIPBOARD_GATE.enter();
    clipboard::capture(
        &mut WinClipboard,
        &mut SendKeys,
        &SystemClock::new(),
        timeout,
    )
}

pub(crate) fn wait_for_clipboard_restore() {
    drop(CLIPBOARD_GATE.enter());
}

pub(crate) fn foreground_window() -> Option<WindowInfo> {
    let foreground = unsafe { GetForegroundWindow() };
    if foreground.is_invalid() {
        return None;
    }
    let mut process_id = 0;
    let thread_id = unsafe { GetWindowThreadProcessId(foreground, Some(&mut process_id)) };
    let mut gui = GUITHREADINFO {
        cbSize: size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    let has_info = thread_id != 0 && unsafe { GetGUIThreadInfo(thread_id, &mut gui) }.is_ok();
    let (focus_class, has_caret) = if has_info {
        let focused = if gui.hwndFocus.is_invalid() {
            foreground
        } else {
            gui.hwndFocus
        };
        (Some(class_name(focused)), !gui.hwndCaret.is_invalid())
    } else {
        (None, false)
    };
    Some(WindowInfo {
        hwnd: foreground.0 as isize,
        process_id,
        class_name: class_name(foreground),
        target: classify(focus_class.as_deref(), has_caret),
        focus_class,
        has_caret,
    })
}

fn class_name(hwnd: HWND) -> String {
    let mut buf = [0u16; 256];
    let len = unsafe { GetClassNameW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..len.max(0) as usize])
}

struct SendKeys;

impl Keyboard for SendKeys {
    fn send(&mut self, batch: &[Stroke]) -> Result<(), InputError> {
        let inputs: Vec<INPUT> = batch.iter().map(to_input).collect();
        let inserted = unsafe { SendInput(&inputs, size_of::<INPUT>() as i32) } as usize;
        if inserted >= inputs.len() {
            return Ok(());
        }
        // UIPI blocks input into an app that runs as administrator, and
        // SendInput then inserts fewer events than it was given. Release
        // whatever did go down so Ctrl isn't left held.
        let release: Vec<INPUT> = strokes::release_after(&batch[..inserted])
            .iter()
            .map(to_input)
            .collect();
        if !release.is_empty() {
            unsafe { SendInput(&release, size_of::<INPUT>() as i32) };
        }
        Err(InputError::Blocked)
    }
}

fn to_input(stroke: &Stroke) -> INPUT {
    let (vk, scan, flags) = match *stroke {
        Stroke::Key { vk, up } => {
            // Ownkey's keyboard library sent the scan code with the virtual
            // key; some apps look only at the scan code.
            let scan = unsafe { MapVirtualKeyW(u32::from(vk), MAPVK_VK_TO_VSC) } as u16;
            let flags = if up {
                KEYEVENTF_KEYUP
            } else {
                KEYBD_EVENT_FLAGS(0)
            };
            (VIRTUAL_KEY(vk), scan, flags)
        }
        Stroke::Unicode { unit, up } => {
            let flags = if up {
                KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
            } else {
                KEYEVENTF_UNICODE
            };
            (VIRTUAL_KEY(0), unit, flags)
        }
    };
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

/// The clipboard, open on this thread until dropped.
struct Open {
    owner: HWND,
}

impl Open {
    fn new() -> Result<Open, InputError> {
        // Opened without a window, EmptyClipboard leaves the clipboard without
        // an owner and SetClipboardData may fail. The message-only window
        // lives only while the clipboard is open, so no other app ever waits
        // on it for a clipboard message.
        let owner = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("STATIC"),
                PCWSTR::null(),
                WINDOW_STYLE(0),
                0,
                0,
                0,
                0,
                Some(HWND_MESSAGE),
                None,
                None,
                None,
            )
        }
        .map_err(clipboard_error)?;
        let deadline = Instant::now() + OPEN_TIMEOUT;
        loop {
            if unsafe { OpenClipboard(Some(owner)) }.is_ok() {
                return Ok(Open { owner });
            }
            if Instant::now() >= deadline {
                let _ = unsafe { DestroyWindow(owner) };
                return Err(InputError::ClipboardBusy);
            }
            thread::sleep(OPEN_RETRY);
        }
    }
}

impl Drop for Open {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseClipboard();
            let _ = DestroyWindow(self.owner);
        }
    }
}

struct WinClipboard;

impl Clipboard for WinClipboard {
    fn sequence(&self) -> u32 {
        unsafe { GetClipboardSequenceNumber() }
    }

    fn snapshot(&mut self) -> Result<Snapshot, InputError> {
        let _open = Open::new()?;
        let mut formats = Vec::new();
        let mut id = 0;
        loop {
            id = unsafe { EnumClipboardFormats(id) };
            if id == 0 {
                break;
            }
            if !clipboard::holds_hglobal(id)
                || format_name(id).is_some_and(|name| clipboard::is_process_bound(&name))
            {
                continue;
            }
            // A format its owner fails to render is left out rather than
            // failing the whole paste.
            if let Some(data) = read_global(id) {
                formats.push(Format { id, data });
            }
        }
        Ok(Snapshot { formats })
    }

    fn set_text(&mut self, text: &str) -> Result<(), InputError> {
        let data: Vec<u8> = text
            .encode_utf16()
            .chain([0])
            .flat_map(u16::to_le_bytes)
            .collect();
        let _open = Open::new()?;
        unsafe { EmptyClipboard() }.map_err(clipboard_error)?;
        put(format::UNICODETEXT, &data)?;
        hide_from_history()
    }

    fn text(&mut self) -> Result<Option<String>, InputError> {
        let _open = Open::new()?;
        let Some(data) = read_global(format::UNICODETEXT) else {
            return Ok(None);
        };
        // GlobalSize can round up, so stop at the terminating zero.
        let units: Vec<u16> = data
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .take_while(|&unit| unit != 0)
            .collect();
        Ok(Some(String::from_utf16_lossy(&units)))
    }

    fn restore(&mut self, snapshot: &Snapshot) -> Result<(), InputError> {
        let _open = Open::new()?;
        unsafe { EmptyClipboard() }.map_err(clipboard_error)?;
        if snapshot.formats.is_empty() {
            return Ok(());
        }
        let mut result = Ok(());
        for format in &snapshot.formats {
            if let Err(err) = put(format.id, &format.data) {
                result = result.and(Err(err));
            }
        }
        // Putting the user's own content back isn't a new copy, so it doesn't
        // belong in clipboard history a second time.
        hide_from_history()?;
        result
    }
}

fn format_name(id: u32) -> Option<String> {
    let mut buf = [0u16; 256];
    let len = unsafe { GetClipboardFormatNameW(id, &mut buf) };
    (len > 0).then(|| String::from_utf16_lossy(&buf[..len as usize]))
}

/// Copies the bytes of a global-memory format on the open clipboard.
fn read_global(id: u32) -> Option<Vec<u8>> {
    let handle = unsafe { GetClipboardData(id) }.ok()?;
    if handle.is_invalid() {
        return None;
    }
    let global = HGLOBAL(handle.0);
    unsafe {
        let size = GlobalSize(global);
        let ptr = GlobalLock(global) as *const u8;
        if ptr.is_null() {
            return None;
        }
        let data = std::slice::from_raw_parts(ptr, size).to_vec();
        let _ = GlobalUnlock(global);
        Some(data)
    }
}

/// Puts one format on the open clipboard.
fn put(id: u32, data: &[u8]) -> Result<(), InputError> {
    unsafe {
        // A zero-size moveable block can't be locked, so allocate at least one zeroed byte.
        let global = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, data.len().max(1))
            .map_err(clipboard_error)?;
        let ptr = GlobalLock(global) as *mut u8;
        if ptr.is_null() {
            let err = windows::core::Error::from_thread();
            let _ = GlobalFree(Some(global));
            return Err(clipboard_error(err));
        }
        std::ptr::copy_nonoverlapping(data.as_ptr(), ptr, data.len());
        let _ = GlobalUnlock(global);
        if let Err(err) = SetClipboardData(id, Some(HANDLE(global.0))) {
            let _ = GlobalFree(Some(global));
            return Err(clipboard_error(err));
        }
        // The clipboard owns the memory now.
        Ok(())
    }
}

/// Keeps the clipboard's content out of clipboard history and cloud clipboard.
fn hide_from_history() -> Result<(), InputError> {
    let id =
        unsafe { RegisterClipboardFormatW(w!("ExcludeClipboardContentFromMonitorProcessing")) };
    if id == 0 {
        return Err(clipboard_error(windows::core::Error::from_thread()));
    }
    put(id, &0u32.to_le_bytes())
}

fn clipboard_error(err: windows::core::Error) -> InputError {
    InputError::Clipboard(err.message())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fields(input: &INPUT) -> (u16, u16, u32) {
        let ki = unsafe { input.Anonymous.ki };
        (ki.wVk.0, ki.wScan, ki.dwFlags.0)
    }

    #[test]
    fn unicode_strokes_carry_the_unit_in_the_scan_code() {
        let down = to_input(&Stroke::Unicode {
            unit: 0xD83D,
            up: false,
        });
        let up = to_input(&Stroke::Unicode {
            unit: 0xD83D,
            up: true,
        });
        assert_eq!(down.r#type, INPUT_KEYBOARD);
        assert_eq!(fields(&down), (0, 0xD83D, KEYEVENTF_UNICODE.0));
        assert_eq!(
            fields(&up),
            (0, 0xD83D, (KEYEVENTF_UNICODE | KEYEVENTF_KEYUP).0)
        );
    }

    #[test]
    fn ctrl_v_becomes_four_keyboard_inputs() {
        let inputs: Vec<INPUT> = strokes::paste().iter().map(to_input).collect();
        let vks: Vec<(u16, u32)> = inputs.iter().map(|i| (fields(i).0, fields(i).2)).collect();
        let up = KEYEVENTF_KEYUP.0;
        assert_eq!(vks, [(0x11, 0), (0x56, 0), (0x56, up), (0x11, up)]);
        // MapVirtualKeyW only reads the layout. Left Ctrl is scan code 0x1D on every layout.
        assert_eq!(fields(&inputs[0]).1, 0x1D);
    }

    #[test]
    fn reads_physical_key_state() {
        // Port of Ownkey's test_reads_physical_key_state. F15 is on very few
        // keyboards, so it isn't held while the tests run.
        assert!(!is_key_down(Key::F15));
        assert!(key_state().is_ok());
    }

    #[test]
    fn reads_the_foreground_window_without_failing() {
        // Read-only: GetForegroundWindow and GetGUIThreadInfo change nothing.
        if let Some(window) = foreground_window() {
            assert_ne!(window.hwnd, 0);
            assert!(!window.class_name.is_empty());
        }
    }

    /// These change the real clipboard or send keys to the focused app, so
    /// they need a dedicated desktop (a VM or a spare account), never a PC
    /// someone is using. Run them there with `cargo test -p voice-input -- --ignored`.
    mod desktop {
        use super::super::*;
        use crate::InsertMode;

        #[test]
        #[ignore = "needs a dedicated desktop: changes the real clipboard"]
        fn snapshot_and_restore_round_trip_the_real_clipboard() {
            let mut clipboard = WinClipboard;
            clipboard.set_text("before").unwrap();
            let snapshot = clipboard.snapshot().unwrap();
            clipboard.set_text("after").unwrap();
            clipboard.restore(&snapshot).unwrap();
            assert_eq!(clipboard.text().unwrap().as_deref(), Some("before"));
        }

        #[test]
        #[ignore = "needs a dedicated desktop with Notepad focused: sends Ctrl+V and changes the clipboard"]
        fn paste_puts_the_clipboard_back() {
            let mut clipboard = WinClipboard;
            clipboard.set_text("the user's text").unwrap();
            crate::insert_text("Pasted by voice-input\nsecond line", InsertMode::Paste).unwrap();
            crate::wait_for_clipboard_restore();
            assert_eq!(
                clipboard.text().unwrap().as_deref(),
                Some("the user's text")
            );
        }

        #[test]
        #[ignore = "needs a dedicated desktop with Notepad focused: sends keys"]
        fn types_unicode_and_newlines() {
            crate::insert_text("Typed é 😀\nsecond line", InsertMode::Type).unwrap();
        }

        #[test]
        #[ignore = "needs a dedicated desktop with text selected in Notepad: sends Ctrl+C and changes the clipboard"]
        fn captures_the_selection_and_puts_the_clipboard_back() {
            let mut clipboard = WinClipboard;
            clipboard.set_text("the user's text").unwrap();
            let selection = crate::capture_selection(Duration::from_millis(500)).unwrap();
            assert!(selection.is_some_and(|text| !text.is_empty()));
            assert_eq!(
                clipboard.text().unwrap().as_deref(),
                Some("the user's text")
            );
        }

        #[test]
        #[ignore = "needs a dedicated desktop with an app running as administrator focused: sends keys"]
        fn typing_into_an_elevated_app_reports_blocked() {
            assert_eq!(
                crate::insert_text("x", InsertMode::Type),
                Err(InputError::Blocked)
            );
        }
    }
}
