//! The synthetic screen of tests and live runs (`--test synthetic:…`): numbered slides drawn
//! with GDI into memory, so nothing of the real desktop is ever captured. Like Windows.Graphics
//! Capture it sends frames only when the picture changes: a short burst at each new slide, then
//! nothing until the next.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::SyncSender;
use std::sync::{Arc, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use voice_screen_files::monitors::MonitorInfo;
use windows::core::w;
use windows::Win32::Foundation::{COLORREF, RECT, SIZE};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, CreateFontW, CreateSolidBrush, DeleteDC, DeleteObject,
    FillRect, GdiFlush, GetTextExtentPoint32W, SelectObject, SetBkMode, SetTextColor, TextOutW,
    ANTIALIASED_QUALITY, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CLIP_DEFAULT_PRECIS,
    DEFAULT_CHARSET, DEFAULT_PITCH, DIB_RGB_COLORS, FF_SWISS, FW_BOLD, HBITMAP, HDC, HFONT,
    HGDIOBJ, OUT_DEFAULT_PRECIS, TRANSPARENT,
};

use super::d3d::D3D;
use super::{CapturedFrame, Source};
use crate::args::TestSpec;
use crate::clockwin;
use crate::record::Ev;

/// Frames sent after each change, 66 ms apart, as a real screen sends while a slide draws.
const BURST: u32 = 5;
const FRAME_GAP: Duration = Duration::from_millis(66);
/// Without `text=`, slides read "Screen <n>".
const DEFAULT_WORD: &str = "Screen";

/// The synthetic monitors: `\\.\SYNTHETIC1` … side by side, the first primary, each the size of
/// the spec.
pub fn monitors(spec: &TestSpec) -> Vec<MonitorInfo> {
    (1..=spec.monitors.max(1))
        .map(|n| MonitorInfo {
            id: format!(r"\\.\SYNTHETIC{n}"),
            name: format!("Synthetic {n}"),
            x: ((n - 1) * spec.width) as i32,
            y: 0,
            width: spec.width,
            height: spec.height,
            primary: n == 1,
        })
        .collect()
}

/// The slides count on one clock for the whole process, so a monitor switch or a new device
/// doesn't start them again at 1.
fn epoch() -> Instant {
    static EPOCH: OnceLock<Instant> = OnceLock::new();
    *EPOCH.get_or_init(Instant::now)
}

pub struct SyntheticSource {
    d3d: D3D,
    to_main: SyncSender<Ev>,
    spec: TestSpec,
    worker: Option<(JoinHandle<()>, Arc<AtomicBool>)>,
}

pub fn new(d3d: D3D, to_main: SyncSender<Ev>, spec: &TestSpec) -> SyntheticSource {
    epoch();
    SyntheticSource {
        d3d,
        to_main,
        spec: spec.clone(),
        worker: None,
    }
}

impl Source for SyntheticSource {
    fn start(&mut self, monitor: &MonitorInfo, generation: u64) -> windows::core::Result<()> {
        self.stop();
        let index: u32 = monitor
            .id
            .trim_start_matches(r"\\.\SYNTHETIC")
            .parse()
            .unwrap_or(1);
        let stop = Arc::new(AtomicBool::new(false));
        let (d3d, to_main, spec, flag) = (
            self.d3d.clone(),
            self.to_main.clone(),
            self.spec.clone(),
            stop.clone(),
        );
        let handle = std::thread::Builder::new()
            .name("synthetic-screen".into())
            .spawn(move || {
                crate::com::init_mta();
                run(d3d, to_main, spec, index, generation, flag)
            })
            .map_err(|_| windows::core::Error::empty())?;
        self.worker = Some((handle, stop));
        Ok(())
    }

    fn stop(&mut self) {
        if let Some((handle, stop)) = self.worker.take() {
            stop.store(true, Ordering::SeqCst);
            let _ = handle.join();
        }
    }

    fn device(&self) -> &D3D {
        &self.d3d
    }
}

impl Drop for SyntheticSource {
    fn drop(&mut self) {
        self.stop();
    }
}

fn run(
    d3d: D3D,
    to_main: SyncSender<Ev>,
    spec: TestSpec,
    monitor: u32,
    generation: u64,
    stop: Arc<AtomicBool>,
) {
    let (width, height) = (spec.width & !1, spec.height & !1);
    let Some(mut canvas) = Canvas::new(width, height) else {
        crate::log("the synthetic screen couldn't make its canvas");
        return;
    };
    let word = spec.text.clone().unwrap_or_else(|| DEFAULT_WORD.into());
    let slide_at = |now: Instant| match spec.change_every_ms {
        Some(every) => 1 + now.duration_since(epoch()).as_millis() as u64 / every,
        None => 1,
    };
    let mut shown = 0u64;
    let mut burst = 0u32;
    while !stop.load(Ordering::SeqCst) {
        let now = Instant::now();
        let slide = slide_at(now);
        if slide != shown {
            shown = slide;
            canvas.draw(&format!("{word} {slide}"), slide, monitor);
            burst = BURST;
        }
        if burst > 0 {
            burst -= 1;
            match d3d.upload(width, height, canvas.pixels()) {
                Ok(texture) => {
                    let frame = CapturedFrame {
                        texture,
                        boot: clockwin::boot_100ns(),
                        width,
                        height,
                        dirty: None,
                        generation,
                    };
                    let _ = to_main.try_send(Ev::Frame(frame));
                }
                Err(_) => {
                    let _ = to_main.try_send(Ev::DeviceLost(generation));
                    return;
                }
            }
            std::thread::sleep(FRAME_GAP);
        } else {
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

/// A top-down 32-bit DIB to draw slides into.
struct Canvas {
    dc: HDC,
    bitmap: HBITMAP,
    old: HGDIOBJ,
    font: HFONT,
    bits: *mut u8,
    width: u32,
    height: u32,
}

impl Canvas {
    fn new(width: u32, height: u32) -> Option<Canvas> {
        unsafe {
            let dc = CreateCompatibleDC(None);
            if dc.is_invalid() {
                return None;
            }
            let info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width as i32,
                    biHeight: -(height as i32),
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bits = std::ptr::null_mut();
            let Ok(bitmap) = CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0)
            else {
                let _ = DeleteDC(dc);
                return None;
            };
            let old = SelectObject(dc, bitmap.into());
            let font = CreateFontW(
                (height / 8).max(16) as i32,
                0,
                0,
                0,
                FW_BOLD.0 as i32,
                0,
                0,
                0,
                DEFAULT_CHARSET,
                OUT_DEFAULT_PRECIS,
                CLIP_DEFAULT_PRECIS,
                ANTIALIASED_QUALITY,
                (DEFAULT_PITCH.0 | FF_SWISS.0) as u32,
                w!("Segoe UI"),
            );
            SelectObject(dc, font.into());
            SetBkMode(dc, TRANSPARENT);
            Some(Canvas {
                dc,
                bitmap,
                old,
                font,
                bits: bits.cast(),
                width,
                height,
            })
        }
    }

    /// Black text on white, centered, under a band whose colour says which monitor this is, over
    /// a row of eight cells that show the slide number in binary. A new slide flips at least one
    /// cell, 2% of the screen, so it counts as a change the way a real slide does; one changed
    /// digit alone stays under the saver's 1% threshold.
    fn draw(&mut self, text: &str, slide: u64, monitor: u32) {
        const BANDS: [u32; 4] = [0x00B5_7A2D, 0x0030_9A3B, 0x002F_4FC7, 0x0080_3A8E];
        unsafe {
            let all = RECT {
                left: 0,
                top: 0,
                right: self.width as i32,
                bottom: self.height as i32,
            };
            let white = CreateSolidBrush(COLORREF(0x00FF_FFFF));
            FillRect(self.dc, &all, white);
            let _ = DeleteObject(white.into());
            let band = RECT {
                bottom: (self.height / 12) as i32,
                ..all
            };
            let colour = CreateSolidBrush(COLORREF(BANDS[(monitor as usize - 1) % BANDS.len()]));
            FillRect(self.dc, &band, colour);
            let _ = DeleteObject(colour.into());
            let grey = CreateSolidBrush(COLORREF(0x0040_4040));
            let cell = self.width as i32 / 8;
            for bit in 0..8 {
                if slide >> bit & 1 == 1 {
                    let left = (7 - bit) * cell;
                    let lit = RECT {
                        left,
                        top: self.height as i32 * 5 / 6,
                        right: left + cell,
                        bottom: self.height as i32,
                    };
                    FillRect(self.dc, &lit, grey);
                }
            }
            let _ = DeleteObject(grey.into());
            SetTextColor(self.dc, COLORREF(0));
            let wide: Vec<u16> = text.encode_utf16().collect();
            let mut size = SIZE::default();
            let _ = GetTextExtentPoint32W(self.dc, &wide, &mut size);
            let x = (self.width as i32 - size.cx).max(0) / 2;
            let y = (self.height as i32 - size.cy).max(0) / 2;
            let _ = TextOutW(self.dc, x, y, &wide);
            let _ = GdiFlush();
            // GDI leaves alpha at 0; make every pixel opaque.
            let pixels = std::slice::from_raw_parts_mut(
                self.bits,
                self.width as usize * self.height as usize * 4,
            );
            for alpha in pixels.iter_mut().skip(3).step_by(4) {
                *alpha = 255;
            }
        }
    }

    fn pixels(&self) -> &[u8] {
        unsafe {
            std::slice::from_raw_parts(self.bits, self.width as usize * self.height as usize * 4)
        }
    }
}

impl Drop for Canvas {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.dc, self.old);
            let _ = DeleteObject(self.font.into());
            let _ = DeleteObject(self.bitmap.into());
            let _ = DeleteDC(self.dc);
        }
    }
}
