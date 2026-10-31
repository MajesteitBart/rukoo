//! The stop button's input: a small native window over the button the page draws (pill-settings-design.md
//! 3.7). The pill window stays click-through, so WebView2 never gets pointer input and has nothing to take
//! focus with. This window is layered with alpha 1: invisible, yet still hit-tested (alpha 0 would let
//! clicks through). It answers WM_MOUSEACTIVATE with MA_NOACTIVATE, so a click leaves the user's app in the
//! foreground with its keyboard focus.

use std::cell::Cell;
use std::sync::Once;

use windows::core::{w, Result, HSTRING, PCWSTR};
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    ReleaseCapture, SetCapture, TrackMouseEvent, TME_LEAVE, TRACKMOUSEEVENT,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, GetClientRect, GetWindowLongPtrW,
    IsWindowVisible, LoadCursorW, RegisterClassExW, SetCursor, SetLayeredWindowAttributes,
    SetWindowLongPtrW, SetWindowPos, SetWindowTextW, ShowWindow, CREATESTRUCTW, GWLP_USERDATA,
    HTCLIENT, HWND_TOPMOST, IDC_HAND, LWA_ALPHA, MA_NOACTIVATE, SWP_NOACTIVATE, SWP_SHOWWINDOW,
    SW_HIDE, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEACTIVATE, WM_MOUSEMOVE, WM_NCCREATE,
    WM_NCDESTROY, WM_NCHITTEST, WM_SETCURSOR, WNDCLASSEXW, WS_EX_LAYERED, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
};

use crate::pill::place::Rect;

const CLASS: PCWSTR = w!("RukooVoiceStopButton");
/// Not in the windows crate's WindowsAndMessaging module.
const WM_MOUSELEAVE: u32 = 0x02A3;
const EX_STYLE: u32 = WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0 | WS_EX_TOPMOST.0 | WS_EX_LAYERED.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HitEvent {
    /// For `pill://pointer`: the page colours the button.
    Pointer { hover: bool, pressed: bool },
    /// One press and release inside the button.
    Click,
}

pub type HitHandler = Box<dyn Fn(HitEvent)>;

/// Cells, because the handler may cause messages that re-enter the window procedure.
struct State {
    handler: HitHandler,
    pressed: Cell<bool>,
    tracking: Cell<bool>,
    reported: Cell<(bool, bool)>,
}

impl State {
    fn report(&self, hover: bool, pressed: bool) {
        if self.reported.replace((hover, pressed)) != (hover, pressed) {
            (self.handler)(HitEvent::Pointer { hover, pressed });
        }
    }
}

/// Owned by the event loop thread, like every window.
pub struct HitWindow {
    hwnd: HWND,
}

impl HitWindow {
    /// A hidden stop window. `title` is what screen readers announce (`pill.stopButton`).
    pub fn create(title: &str, handler: HitHandler) -> Result<HitWindow> {
        register_class();
        let state = Box::into_raw(Box::new(State {
            handler,
            pressed: Cell::new(false),
            tracking: Cell::new(false),
            reported: Cell::new((false, false)),
        }));
        unsafe {
            let instance = GetModuleHandleW(None)?;
            let hwnd = CreateWindowExW(
                windows::Win32::UI::WindowsAndMessaging::WINDOW_EX_STYLE(EX_STYLE),
                CLASS,
                &HSTRING::from(title),
                WS_POPUP,
                0,
                0,
                1,
                1,
                None,
                None,
                Some(instance.into()),
                Some(state as *const _),
            );
            let hwnd = match hwnd {
                Ok(hwnd) => hwnd,
                Err(error) => {
                    // WM_NCCREATE never stored the state, so it is still ours to free.
                    drop(Box::from_raw(state));
                    return Err(error);
                }
            };
            SetLayeredWindowAttributes(hwnd, COLORREF(0), 1, LWA_ALPHA)?;
            Ok(HitWindow { hwnd })
        }
    }

    pub fn hwnd(&self) -> HWND {
        self.hwnd
    }

    pub fn set_title(&self, title: &str) {
        unsafe {
            let _ = SetWindowTextW(self.hwnd, &HSTRING::from(title));
        }
    }

    /// Over the button and above the pill: called right after every raise of the pill, so it sits
    /// directly above it in the topmost band.
    pub fn show_at(&self, r: Rect) {
        unsafe {
            let _ = SetWindowPos(
                self.hwnd,
                Some(HWND_TOPMOST),
                r.left,
                r.top,
                r.width(),
                r.height(),
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            );
        }
    }

    pub fn hide(&self) {
        unsafe {
            let _ = ShowWindow(self.hwnd, SW_HIDE);
        }
    }

    pub fn is_visible(&self) -> bool {
        unsafe { IsWindowVisible(self.hwnd).as_bool() }
    }
}

impl Drop for HitWindow {
    fn drop(&mut self) {
        unsafe {
            let _ = DestroyWindow(self.hwnd);
        }
    }
}

fn register_class() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| unsafe {
        let Ok(instance) = GetModuleHandleW(None) else {
            return;
        };
        let class = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(proc),
            hInstance: instance.into(),
            hCursor: LoadCursorW(None, IDC_HAND).unwrap_or_default(),
            lpszClassName: CLASS,
            ..Default::default()
        };
        if RegisterClassExW(&class) == 0 {
            log::error!("pill: could not register the stop window class");
        }
    });
}

fn point(lparam: LPARAM) -> (i32, i32) {
    // GET_X_LPARAM / GET_Y_LPARAM: signed, so a release left of or above the window reads as outside.
    let x = (lparam.0 & 0xffff) as u16 as i16 as i32;
    let y = ((lparam.0 >> 16) & 0xffff) as u16 as i16 as i32;
    (x, y)
}

fn inside(hwnd: HWND, lparam: LPARAM) -> bool {
    let (x, y) = point(lparam);
    let mut client = RECT::default();
    unsafe { GetClientRect(hwnd, &mut client) }.is_ok()
        && x >= client.left
        && x < client.right
        && y >= client.top
        && y < client.bottom
}

unsafe extern "system" fn proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    unsafe {
        if msg == WM_NCCREATE {
            let create = &*(lparam.0 as *const CREATESTRUCTW);
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, create.lpCreateParams as isize);
            return DefWindowProcW(hwnd, msg, wparam, lparam);
        }
        let state = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const State;
        if msg == WM_NCDESTROY {
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
            if !state.is_null() {
                drop(Box::from_raw(state as *mut State));
            }
            return DefWindowProcW(hwnd, msg, wparam, lparam);
        }
        if state.is_null() {
            return DefWindowProcW(hwnd, msg, wparam, lparam);
        }
        let state = &*state;
        match msg {
            WM_MOUSEACTIVATE => LRESULT(MA_NOACTIVATE as isize),
            WM_NCHITTEST => LRESULT(HTCLIENT as isize),
            WM_SETCURSOR => {
                if let Ok(cursor) = LoadCursorW(None, IDC_HAND) {
                    SetCursor(Some(cursor));
                }
                LRESULT(1)
            }
            WM_MOUSEMOVE => {
                if !state.tracking.get() {
                    let mut track = TRACKMOUSEEVENT {
                        cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                        dwFlags: TME_LEAVE,
                        hwndTrack: hwnd,
                        dwHoverTime: 0,
                    };
                    state.tracking.set(TrackMouseEvent(&mut track).is_ok());
                }
                state.report(true, state.pressed.get());
                LRESULT(0)
            }
            WM_MOUSELEAVE => {
                state.tracking.set(false);
                state.pressed.set(false);
                state.report(false, false);
                LRESULT(0)
            }
            WM_LBUTTONDOWN => {
                SetCapture(hwnd);
                state.pressed.set(true);
                state.report(true, true);
                LRESULT(0)
            }
            WM_LBUTTONUP => {
                // One click per press and release inside the button; a release without our press, or
                // one dragged off the button, is not a click.
                let was_pressed = state.pressed.replace(false);
                let _ = ReleaseCapture();
                let inside = inside(hwnd, lparam);
                if was_pressed && inside {
                    (state.handler)(HitEvent::Click);
                }
                state.report(inside, false);
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::rc::Rc;

    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SendMessageW, SetWindowPos, GWL_EXSTYLE, MA_NOACTIVATE, SWP_NOACTIVATE,
        SWP_NOZORDER, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEACTIVATE, WM_MOUSEMOVE,
        WS_EX_APPWINDOW,
    };

    use super::*;

    fn lparam(x: i32, y: i32) -> LPARAM {
        LPARAM(((y as u16 as isize) << 16) | (x as u16 as isize))
    }

    fn send(window: &HitWindow, msg: u32, wparam: usize, lp: LPARAM) -> isize {
        unsafe { SendMessageW(window.hwnd(), msg, Some(WPARAM(wparam)), Some(lp)).0 }
    }

    /// The stop window is never shown here: it is created hidden, far off screen, and only receives
    /// messages sent straight to its window procedure, so no desktop input is involved.
    fn hidden_window(events: &Rc<RefCell<Vec<HitEvent>>>) -> HitWindow {
        let sink = events.clone();
        let window = HitWindow::create(
            "Stop recording",
            Box::new(move |e| sink.borrow_mut().push(e)),
        )
        .unwrap();
        unsafe {
            SetWindowPos(
                window.hwnd(),
                None,
                -32000,
                -32000,
                28,
                28,
                SWP_NOACTIVATE | SWP_NOZORDER,
            )
            .unwrap();
        }
        assert!(!window.is_visible());
        window
    }

    fn clicks(events: &Rc<RefCell<Vec<HitEvent>>>) -> usize {
        events
            .borrow()
            .iter()
            .filter(|e| **e == HitEvent::Click)
            .count()
    }

    #[test]
    fn a_click_never_activates_and_counts_once() {
        let events = Rc::new(RefCell::new(Vec::new()));
        let window = hidden_window(&events);

        assert_eq!(
            send(&window, WM_MOUSEACTIVATE, 0, LPARAM(0)),
            MA_NOACTIVATE as isize
        );
        send(&window, WM_LBUTTONDOWN, 0x0001, lparam(10, 12));
        send(&window, WM_LBUTTONUP, 0, lparam(10, 12));
        assert_eq!(clicks(&events), 1);

        // A second release without a press is not another click.
        send(&window, WM_LBUTTONUP, 0, lparam(10, 12));
        assert_eq!(clicks(&events), 1);

        // Pressed on the button, released off it: no click.
        send(&window, WM_LBUTTONDOWN, 0x0001, lparam(10, 12));
        send(&window, WM_LBUTTONUP, 0, lparam(40, 12));
        send(&window, WM_LBUTTONDOWN, 0x0001, lparam(10, 12));
        send(&window, WM_LBUTTONUP, 0, lparam(-3, 12));
        assert_eq!(clicks(&events), 1);
    }

    #[test]
    fn hover_and_press_are_reported_for_the_page() {
        let events = Rc::new(RefCell::new(Vec::new()));
        let window = hidden_window(&events);
        send(&window, WM_MOUSEMOVE, 0, lparam(5, 5));
        send(&window, WM_MOUSEMOVE, 0, lparam(6, 5));
        send(&window, WM_LBUTTONDOWN, 0x0001, lparam(6, 5));
        send(&window, WM_LBUTTONUP, 0, lparam(6, 5));
        send(&window, WM_MOUSELEAVE, 0, LPARAM(0));
        let pointer: Vec<_> = events
            .borrow()
            .iter()
            .copied()
            .filter(|e| *e != HitEvent::Click)
            .collect();
        assert_eq!(
            pointer,
            vec![
                HitEvent::Pointer {
                    hover: true,
                    pressed: false
                },
                HitEvent::Pointer {
                    hover: true,
                    pressed: true
                },
                HitEvent::Pointer {
                    hover: true,
                    pressed: false
                },
                HitEvent::Pointer {
                    hover: false,
                    pressed: false
                },
            ]
        );
    }

    #[test]
    fn the_window_is_a_non_activating_topmost_tool_window() {
        let events = Rc::new(RefCell::new(Vec::new()));
        let window = hidden_window(&events);
        let ex = unsafe { GetWindowLongPtrW(window.hwnd(), GWL_EXSTYLE) } as u32;
        assert_eq!(ex & EX_STYLE, EX_STYLE, "ex style {ex:#010x}");
        assert_eq!(ex & WS_EX_APPWINDOW.0, 0);
    }
}
