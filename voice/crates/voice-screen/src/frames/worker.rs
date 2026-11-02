//! The JPEG and OCR thread. The main thread queues the frames it decided to keep; this thread
//! writes each JPEG (`.jpg.tmp`, synced, renamed), reads its text and hands the `frame` line back
//! for the journal. OCR can fall behind without slowing capture: with eight frames waiting, the
//! oldest keeps its JPEG and skips OCR (`ocr: "skipped"`).

use std::collections::VecDeque;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, SyncSender};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use voice_screen_files::frames::clean_text;
use voice_screen_files::journal::Line;
use voice_screen_files::paths;

use super::jpeg::{self, Pixels};
use super::ocr::Ocr;
use crate::record::Ev;

/// Frames waiting for OCR before the oldest skips it.
pub const QUEUE: usize = 8;

pub struct FrameJob {
    pub id: String,
    pub t: u64,
    pub pixels: Pixels,
}

/// What became of a job.
#[derive(Debug)]
pub enum FrameDone {
    /// The JPEG is on disk; the `frame` line goes into the journal.
    Saved(Line),
    /// The JPEG couldn't be written. `disk_full` drops the frames (spec 2.6).
    Failed {
        id: String,
        t: u64,
        disk_full: bool,
        error: String,
    },
}

#[derive(Default)]
struct State {
    jobs: VecDeque<(FrameJob, bool)>,
    busy: bool,
    closing: bool,
    skip_ocr: bool,
}

struct Shared {
    state: Mutex<State>,
    ready: Condvar,
}

pub struct FrameWorker {
    shared: Arc<Shared>,
    handle: Option<JoinHandle<()>>,
    /// Closes when the thread's work is done, so `join` can wait with a limit.
    finished: Option<mpsc::Receiver<()>>,
}

impl FrameWorker {
    /// Starts the thread. `write_fail_at` is the `write-fail=frames@<ms>` test switch: from that
    /// meeting time every JPEG write fails as a full disk.
    pub fn start(
        meeting: PathBuf,
        to_main: SyncSender<Ev>,
        write_fail_at: Option<u64>,
    ) -> FrameWorker {
        let shared = Arc::new(Shared {
            state: Mutex::new(State::default()),
            ready: Condvar::new(),
        });
        let thread_shared = shared.clone();
        let (finished_tx, finished) = mpsc::channel::<()>();
        let handle = std::thread::Builder::new()
            .name("frames".into())
            .spawn(move || {
                // Dropped when the thread ends, also by a panic: `join` stops waiting.
                let _finished = finished_tx;
                crate::com::init_mta();
                let ocr = Ocr::new();
                run(&meeting, &ocr, &thread_shared, &to_main, write_fail_at);
            })
            .ok();
        FrameWorker {
            shared,
            handle,
            finished: Some(finished),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.shared.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Queues a frame. With `QUEUE` waiting, the oldest that would still be read skips OCR.
    pub fn send(&self, job: FrameJob) {
        let mut state = self.state();
        if state.jobs.len() >= QUEUE {
            if let Some(oldest) = state.jobs.iter_mut().find(|(_, skip)| !*skip) {
                oldest.1 = true;
            }
        }
        state.jobs.push_back((job, false));
        self.shared.ready.notify_one();
    }

    /// Jobs queued or in hand.
    pub fn pending(&self) -> usize {
        let state = self.state();
        state.jobs.len() + usize::from(state.busy)
    }

    /// Forgets queued frames from `t` on, as after a pause or a stop.
    pub fn cancel_from(&self, t: u64) {
        self.state().jobs.retain(|(job, _)| job.t < t);
    }

    /// Forgets every queued frame, as when frames are dropped.
    pub fn clear(&self) {
        self.state().jobs.clear();
    }

    /// From now on frames keep their JPEG and skip OCR, as when the stop drain runs late.
    pub fn skip_ocr(&self) {
        self.state().skip_ocr = true;
        self.shared.ready.notify_all();
    }

    /// Lets the thread end once its queue is empty.
    pub fn close(&mut self) {
        self.state().closing = true;
        self.shared.ready.notify_all();
        self.handle.take();
    }

    /// Lets the thread end and waits for it, so its OCR engine and bitmaps are released on
    /// their own thread before the process exits. A thread still busy after `timeout`, such as
    /// one stuck in OCR, is left behind.
    pub fn join(&mut self, timeout: Duration) {
        self.state().closing = true;
        self.shared.ready.notify_all();
        if let Some(finished) = self.finished.take() {
            if finished.recv_timeout(timeout) == Err(mpsc::RecvTimeoutError::Timeout) {
                crate::log("the frame thread didn't end in time; leaving it");
                self.handle.take();
                return;
            }
        }
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for FrameWorker {
    fn drop(&mut self) {
        self.close();
    }
}

fn run(
    meeting: &Path,
    ocr: &Ocr,
    shared: &Shared,
    to_main: &SyncSender<Ev>,
    write_fail_at: Option<u64>,
) {
    loop {
        let (job, skip) = {
            let mut state = shared.state.lock().unwrap_or_else(|e| e.into_inner());
            state.busy = false;
            loop {
                if let Some((job, skip)) = state.jobs.pop_front() {
                    state.busy = true;
                    break (job, skip || state.skip_ocr);
                }
                if state.closing {
                    return;
                }
                state = shared.ready.wait(state).unwrap_or_else(|e| e.into_inner());
            }
        };
        let done = process(meeting, ocr, job, skip, write_fail_at);
        let mut event = Ev::FrameDone(done);
        loop {
            match to_main.try_send(event) {
                Ok(()) => break,
                Err(mpsc::TrySendError::Disconnected(_)) => return,
                Err(mpsc::TrySendError::Full(back)) => {
                    event = back;
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
        }
    }
}

fn process(
    meeting: &Path,
    ocr: &Ocr,
    job: FrameJob,
    skip_ocr: bool,
    write_fail_at: Option<u64>,
) -> FrameDone {
    let FrameJob { id, t, pixels } = job;
    let failed = |disk_full: bool, error: String| FrameDone::Failed {
        id: id.clone(),
        t,
        disk_full,
        error,
    };
    let file = paths::frame_file(&id);
    let path = meeting.join(&file);
    let started = Instant::now();
    let (bytes, width, height) = match jpeg::bitmap(&pixels).and_then(|b| jpeg::encode(&b)) {
        Ok(encoded) => encoded,
        Err(e) => return failed(false, format!("JPEG encoding failed: {:#010x}", e.code().0)),
    };
    let jpeg_ms = started.elapsed().as_millis();
    let fault = write_fail_at.is_some_and(|at| t >= at);
    if let Err(e) = write_synced(&path, &bytes, fault) {
        return failed(crate::disk::is_disk_full(&e), e.to_string());
    }
    let started = Instant::now();
    let (text, status) = if skip_ocr {
        (String::new(), "skipped")
    } else if !ocr.available() {
        (String::new(), "none")
    } else {
        match ocr.read_pixels(&pixels) {
            Ok(lines) => (clean_text(&lines), "ok"),
            Err(_) => (String::new(), "failed"),
        }
    };
    // By id, size and timing only: never the text (section 7 reads the timings from here).
    crate::log(format_args!(
        "frame {id}: {width}x{height}, {} bytes, jpeg {jpeg_ms} ms, ocr {} ms ({status})",
        bytes.len(),
        started.elapsed().as_millis()
    ));
    FrameDone::Saved(Line::Frame {
        t,
        id,
        file,
        width,
        height,
        text,
        ocr: status.into(),
        language: ocr.language(),
    })
}

/// `<path>.tmp`, synced, then renamed to `path`; nothing stays on failure.
fn write_synced(path: &Path, bytes: &[u8], fault: bool) -> io::Result<()> {
    let tmp = path.with_extension("jpg.tmp");
    let result = (|| {
        if fault {
            // ERROR_DISK_FULL, as a full disk reports it.
            return Err(io::Error::from_raw_os_error(112));
        }
        let mut f = File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failed_write_leaves_nothing() {
        let dir = std::env::temp_dir().join(format!("voice-screen-worker-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("f-000001000.jpg");
        let e = write_synced(&path, b"jpeg", true).unwrap_err();
        assert!(crate::disk::is_disk_full(&e));
        assert!(!path.exists() && !path.with_extension("jpg.tmp").exists());
        write_synced(&path, b"jpeg", false).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"jpeg");
        assert!(!path.with_extension("jpg.tmp").exists());
        fs::remove_dir_all(&dir).unwrap();
    }
}
