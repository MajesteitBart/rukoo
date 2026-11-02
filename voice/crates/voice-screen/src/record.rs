//! `rukoo-voice-screen record`: one process per meeting, next to the recorder.
//!
//! The main thread owns the journal, the clock, the drop state and the capture. Capture frames,
//! the JPEG/OCR worker, the video threads and the control port all talk to it through one
//! queue of `Ev`. It follows the recorder's `timeline.jsonl` every 250 ms for the clock, pause,
//! resume and stop, and stops itself when the recorder has been silent for a minute of awake
//! time with nobody asking its status: the screen is never recorded without the audio.
//!
//! Startup order (spec 4.2): refuse a live `screen.json` (4), a journal with `stop` (3) or a
//! journal without `--resume` (3); open the journal; on `--resume` repair the open video file,
//! write its `video_end crash` and journal orphan JPEGs; wait up to 5 s for a `session` line in
//! the timeline (else exit 1); bind the control port; write `session` (and `crash`); write
//! `screen.json`; choose the monitor and write `monitor`; start capturing, writing `capture` on
//! the first frame.

use std::fs;
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use voice_screen_files::clock::{Fed, ScreenClock, REANCHOR_SPLIT_MS};
use voice_screen_files::control::{self, Request};
use voice_screen_files::frames::{Decision, Saver, Thumb, DIRTY_SKIP};
use voice_screen_files::journal::{self, History, JournalWriter, Line, OpenError, FORMAT_VERSION};
use voice_screen_files::monitors::{self, MonitorInfo};
use voice_screen_files::paths;
use voice_screen_files::policy::{
    DropState, EncoderStep, Part, Reason, DISK_CHECK_MS, ENCODER_RETRY_MS,
};
use voice_screen_files::screenfile::{self, ScreenFile};
use voice_screen_files::timeline::{TimelineFollower, TimelineLine};

use crate::args::{Mode, RecordOptions, TestSpec};
use crate::capture::d3d::{self, is_device_lost, D3D};
use crate::capture::{monitors_win, session, synthetic, wgc, CapturedFrame, Source};
use crate::clockwin;
use crate::finalize;
use crate::frames::jpeg;
use crate::frames::ocr::Ocr;
use crate::frames::thumb::Thumbnailer;
use crate::frames::worker::{FrameDone, FrameJob, FrameWorker};
use crate::video::thread::{self as video_thread, VideoStart, VideoThread};
use crate::video::writer::{VideoError, WriterOptions};
use crate::video::{mf, FPS};
use crate::{log, ExitError, VERSION};

/// What reaches the main thread.
pub enum Ev {
    /// A captured frame.
    Frame(CapturedFrame),
    /// The worker wrote a JPEG and read it, or failed to.
    FrameDone(FrameDone),
    /// A control port request with a good token.
    Control(Request),
    /// A video file's encoder thread failed.
    VideoError { seq: u64, error: VideoError },
    /// The capture of this generation saw the graphics device go.
    DeviceLost(u64),
    /// The monitor of this generation's capture went away.
    CaptureClosed(u64),
}

const TICK: Duration = Duration::from_millis(250);
const HEARTBEAT: Duration = Duration::from_secs(2);
const LOCK_CHECK: Duration = Duration::from_secs(1);
/// At most five thumbnails a second.
const THUMB_GAP: Duration = Duration::from_millis(200);
/// A still screen sends no frames, so the last one is offered again this often, letting the
/// saver see that the screen settled.
const REOFFER_MS: u64 = 250;
/// `Finalize` of a video file may take this long before the file is left as it is.
const FINISH_WAIT: Duration = Duration::from_secs(5);
/// OCR still running at the stop gets this long, then frames keep only their JPEG.
const DRAIN_WAIT: Duration = Duration::from_secs(5);
const DRAIN_EXTRA: Duration = Duration::from_secs(2);
/// After the stop line, the frame thread gets this long to end; a hung OCR call doesn't keep
/// the process alive.
const WORKER_JOIN: Duration = Duration::from_secs(5);
const MEMORY_LOG: Duration = Duration::from_secs(60);
/// How long to wait for the recorder's `session` line at startup.
const SESSION_WAIT: Duration = Duration::from_secs(5);
/// No new timeline line and no status request for this long, awake: the recorder is gone.
const ORPHAN: Duration = Duration::from_secs(60);
const CAPTURE_RETRY: Duration = Duration::from_secs(1);
const DEVICE_RETRY_PAUSE: Duration = Duration::from_millis(500);
const EVENT_QUEUE: usize = 64;
const MONITOR_CACHE: Duration = Duration::from_secs(2);
/// With `free-bytes-file` the file is read this often, so tests step through the thresholds
/// quickly; the decision is the same.
const TEST_DISK_CHECK: Duration = Duration::from_millis(500);

/// What the timeline said before the screen process started.
#[derive(Default)]
struct TimelineState {
    sessions: u64,
    paused: bool,
    stop: Option<u64>,
}

impl TimelineState {
    fn read(&mut self, line: &TimelineLine) {
        match line {
            TimelineLine::Session { .. } => self.sessions += 1,
            TimelineLine::Pause { .. } => self.paused = true,
            TimelineLine::Resume { .. } => self.paused = false,
            TimelineLine::Stop { t, .. } => self.stop = Some(*t),
            _ => {}
        }
    }
}

pub fn record(opts: RecordOptions) -> Result<(), ExitError> {
    crate::com::init_mta();
    crate::com::dpi_aware();
    let dir = opts.meeting.clone();
    if !dir.is_dir() {
        return Err(ExitError::usage(format!(
            "meeting folder {} doesn't exist",
            dir.display()
        )));
    }
    if screenfile::live(&dir).is_some() {
        return Err(ExitError::busy());
    }
    let lines = journal::read_all(&dir)
        .map_err(|e| ExitError::failed(format!("can't read the screen journal: {e}")))?;
    let history = History::from_lines(&lines);
    if history.stopped.is_some() {
        return Err(ExitError::conflict(
            "the meeting's screen recording has stopped; nothing can follow its stop line",
        ));
    }
    if (!lines.is_empty() || finalize::has_media(&dir)) && !opts.resume {
        return Err(ExitError::conflict(
            "the meeting already has a screen recording; continue it with --resume",
        ));
    }
    let monitor_list = list_monitors(opts.test.as_ref());
    let pinned = match &opts.monitor {
        Some(id) => Some(
            monitor_list
                .iter()
                .find(|m| &m.id == id)
                .cloned()
                .ok_or_else(|| ExitError::failed(format!("monitor {id} isn't there")))?,
        ),
        None => None,
    };
    if monitor_list.is_empty() {
        return Err(ExitError::failed("there is no monitor to record"));
    }
    if opts.test.is_none() && !wgc::supported() {
        return Err(ExitError::failed("this Windows can't capture the screen"));
    }
    let frames_dir = paths::screen_dir(&dir).join("frames");
    fs::create_dir_all(&frames_dir)
        .map_err(|e| ExitError::failed(format!("can't create the screen folder: {e}")))?;
    let mut journal = match JournalWriter::open(&dir) {
        Ok(journal) => journal,
        Err(OpenError::Busy) => return Err(ExitError::busy()),
        Err(OpenError::Io(e)) => {
            return Err(ExitError::failed(format!(
                "can't open the screen journal: {e}"
            )))
        }
    };

    // A resumed session first closes what the dead one left open.
    let resumed = history.sessions > 0;
    let mut last_seen = history.last_seen;
    if resumed {
        let (_, video_end) = finalize::close_open_video(&dir, &mut journal, &lines, &history);
        last_seen = last_seen.max(video_end);
        let ocr = Ocr::new();
        last_seen = last_seen.max(finalize::journal_orphans(
            &dir,
            &mut journal,
            &history,
            &ocr,
        ));
    }
    finalize::remove_temp_files(&dir);

    // The recorder's clock: its `session` and `heartbeat` lines anchor ours.
    let mut follower = TimelineFollower::new(&dir);
    let mut clock = ScreenClock::new();
    let mut timeline = TimelineState::default();
    let deadline = Instant::now() + SESSION_WAIT;
    loop {
        for line in follower.poll().unwrap_or_default() {
            timeline.read(&line);
            clock.feed(&line, clockwin::now());
        }
        if timeline.sessions > 0 && clock.at(clockwin::now()).is_some() {
            break;
        }
        if Instant::now() >= deadline {
            return Err(ExitError::failed(
                "the recorder's timeline has no session line to take the meeting clock from",
            ));
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    let listener = control::bind()
        .map_err(|e| ExitError::failed(format!("can't open the control port: {e}")))?;
    let port = listener
        .local_addr()
        .map_err(|e| ExitError::failed(e.to_string()))?
        .port();
    let token = control::new_token().map_err(|e| ExitError::failed(e.to_string()))?;
    let now = clockwin::now();
    let t0 = clock.at(now).unwrap_or(0);
    let session = history.sessions + 1;
    let line = Line::Session {
        t: t0,
        wall: now.wall,
        boot: now.boot,
        session,
        pid: std::process::id(),
        resumed,
        version: FORMAT_VERSION,
        mode: opts.mode.as_str().into(),
        anchor: if clock.uses_boot() { "boot" } else { "wall" }.into(),
        screen: VERSION.into(),
    };
    journal
        .write(&line)
        .map_err(|e| ExitError::failed(format!("can't write the screen journal: {e}")))?;
    if resumed {
        let _ = journal.write(&Line::Crash {
            t: t0,
            last_seen: last_seen.min(t0),
        });
    }
    journal.sync();
    let drops = DropState::from_history(&history, opts.mode == Mode::Video);

    let (events, rx) = mpsc::sync_channel(EVENT_QUEUE);
    let (requests, request_rx) = mpsc::sync_channel::<Request>(16);
    control::serve(listener, token.clone(), requests)
        .map_err(|e| ExitError::failed(format!("can't start the control port: {e}")))?;
    let forward = events.clone();
    std::thread::Builder::new()
        .name("control-forward".into())
        .spawn(move || {
            for request in request_rx {
                if forward.send(Ev::Control(request)).is_err() {
                    return;
                }
            }
        })
        .map_err(|e| ExitError::failed(format!("can't start the control thread: {e}")))?;
    screenfile::write(
        &dir,
        &ScreenFile {
            pid: std::process::id(),
            port,
            token,
            session,
            started_at: now.wall,
        },
    )
    .map_err(|e| ExitError::failed(format!("can't write screen.json: {e}")))?;

    let monitor = pinned.unwrap_or_else(|| choose_monitor(opts.test.as_ref(), &monitor_list));
    let video_seq = history
        .last_video_seq
        .max(finalize::highest_video_seq(&dir));
    let write_fail_frames = match opts.test.as_ref().and_then(|t| t.write_fail) {
        Some((Part::Frames, at)) => Some(at),
        _ => None,
    };
    let worker = FrameWorker::start(dir.clone(), events.clone(), write_fail_frames);
    let awake = clockwin::awake_100ns();
    let orphan = orphan_after();
    let mut screen = Screen {
        dir,
        mode: opts.mode,
        device_fault_at: opts.test.as_ref().and_then(|t| t.device_lost_at_ms),
        test: opts.test,
        journal,
        clock,
        follower,
        drops,
        events,
        d3d: None,
        source: None,
        thumbs: None,
        saver: Saver::new(),
        worker,
        generation: 0,
        capturing: false,
        awaiting_capture: false,
        captured: false,
        monitor_cache: (Instant::now(), monitor_list),
        monitor,
        pinned: opts.monitor,
        video: None,
        video_seq,
        video_bytes_closed: 0,
        encoder: None,
        rebuild_at: None,
        capture_retry_at: None,
        paused: timeline.paused,
        timeline_paused: timeline.paused,
        pause_from: None,
        locked: false,
        frames_saved: 0,
        last_frame_id: None,
        last: None,
        last_thumb_at: None,
        create_failures: 0,
        no_video_devices: 0,
        had_video_device: false,
        recovering: false,
        stop: None,
        stop_t: None,
        last_activity: awake,
        last_status: awake,
        orphan_100ns: orphan.as_millis() as u64 * 10_000,
        next_heartbeat: Instant::now() + HEARTBEAT,
        next_disk_check: Instant::now(),
        next_lock_check: Instant::now(),
        next_memory_log: Instant::now() + MEMORY_LOG,
        session,
    };
    log(format_args!(
        "session {session}: recording {} of {} ({}x{}){}",
        screen.mode.as_str(),
        screen.monitor.id,
        screen.monitor.width,
        screen.monitor.height,
        if resumed { ", resumed" } else { "" }
    ));
    screen.write_monitor(if resumed { "resume" } else { "start" });
    // At capture start in video mode, a disk already under the floor drops the video at once.
    screen.check_disk();
    if let Some(t) = timeline.stop {
        screen.request_stop(t, "meeting", None);
    }
    screen.start_capture();
    screen.run(rx);
    Ok(())
}

/// The 60 s orphan rule; a development copy's tests shorten it with
/// `VOICE_SCREEN_TEST_ORPHAN_MS`.
fn orphan_after() -> Duration {
    if crate::dev_mode() {
        if let Some(ms) = std::env::var("VOICE_SCREEN_TEST_ORPHAN_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
        {
            return Duration::from_millis(ms.max(500));
        }
    }
    ORPHAN
}

fn list_monitors(test: Option<&TestSpec>) -> Vec<MonitorInfo> {
    match test {
        Some(spec) => synthetic::monitors(spec),
        None => monitors_win::list(),
    }
}

/// The monitor that shows the call (spec 2.7): the topmost real window's, else the cursor's,
/// else the primary.
fn choose_monitor(test: Option<&TestSpec>, list: &[MonitorInfo]) -> MonitorInfo {
    let id = match test {
        Some(_) => monitors::choose(&[], None, list),
        None => monitors::choose(
            &monitors_win::z_order(),
            monitors_win::cursor_monitor().as_deref(),
            list,
        ),
    };
    id.and_then(|id| list.iter().find(|m| m.id == id).cloned())
        .or_else(|| list.iter().find(|m| m.primary).cloned())
        .unwrap_or_else(|| list[0].clone())
}

/// Why capture didn't start.
enum StartFail {
    /// The new graphics device lacks the video support the video needs.
    NoVideo,
    Windows(windows::core::Error),
}

impl From<windows::core::Error> for StartFail {
    fn from(e: windows::core::Error) -> StartFail {
        StartFail::Windows(e)
    }
}

struct Stopping {
    t: u64,
    reason: String,
    replies: Vec<Sender<Value>>,
}

/// The last captured frame, offered again while the screen is still.
struct Last {
    frame: CapturedFrame,
    thumb: Option<Thumb>,
    offered_t: u64,
}

struct Screen {
    dir: PathBuf,
    mode: Mode,
    test: Option<TestSpec>,
    journal: JournalWriter,
    clock: ScreenClock,
    follower: TimelineFollower,
    drops: DropState,
    events: SyncSender<Ev>,
    d3d: Option<D3D>,
    source: Option<Box<dyn Source>>,
    thumbs: Option<Thumbnailer>,
    saver: Saver,
    worker: FrameWorker,
    /// Names the running capture session; frames of older ones are dropped.
    generation: u64,
    capturing: bool,
    /// The next frame writes `capture`.
    awaiting_capture: bool,
    captured: bool,
    monitor_cache: (Instant, Vec<MonitorInfo>),
    monitor: MonitorInfo,
    /// `--monitor`: the only monitor this process may record (spec 2.7).
    pinned: Option<String>,
    video: Option<VideoThread>,
    video_seq: u64,
    video_bytes_closed: u64,
    encoder: Option<(String, bool)>,
    /// The encoder failed once: a new device and a new file at this moment.
    rebuild_at: Option<Instant>,
    capture_retry_at: Option<Instant>,
    paused: bool,
    /// Whether the timeline's latest `pause` or `resume` line is a `pause`. The timeline is what
    /// the recorder did, so a control `resume` that arrives after a newer pause doesn't resume.
    timeline_paused: bool,
    pause_from: Option<u64>,
    locked: bool,
    frames_saved: u64,
    last_frame_id: Option<String>,
    last: Option<Last>,
    last_thumb_at: Option<Instant>,
    device_fault_at: Option<u64>,
    /// Device creations still to fail, from the `device-lost-at=<ms>x<n>` test switch.
    create_failures: u32,
    /// Devices still to come without video support, from the `no-video-device=<n>` test switch.
    no_video_devices: u32,
    /// The process had a graphics device with video support: see `needs_video_device`.
    had_video_device: bool,
    recovering: bool,
    stop: Option<Stopping>,
    stop_t: Option<u64>,
    last_activity: u64,
    last_status: u64,
    orphan_100ns: u64,
    next_heartbeat: Instant,
    next_disk_check: Instant,
    next_lock_check: Instant,
    /// A development copy logs the GPU memory it uses once a minute, for the measurements.
    next_memory_log: Instant,
    session: u64,
}

impl Screen {
    fn run(mut self, rx: Receiver<Ev>) {
        let mut next_tick = Instant::now();
        while self.stop.is_none() {
            let wait = next_tick.saturating_duration_since(Instant::now());
            match rx.recv_timeout(wait) {
                Ok(event) => {
                    self.handle(event);
                    handle_queued(
                        &rx,
                        EVENT_QUEUE,
                        &mut self,
                        |s| s.stop.is_none(),
                        Screen::handle,
                    );
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
            if self.stop.is_none() && Instant::now() >= next_tick {
                self.tick();
                next_tick = Instant::now() + TICK;
            }
        }
        self.finish(&rx);
    }

    fn handle(&mut self, event: Ev) {
        match event {
            Ev::Frame(frame) => self.on_frame(frame),
            Ev::FrameDone(done) => self.on_frame_done(done),
            Ev::Control(request) => self.on_control(request),
            Ev::VideoError { seq, error } => self.on_video_error(seq, error),
            Ev::DeviceLost(generation) => {
                if generation == self.generation && self.capturing {
                    self.on_device_lost();
                }
            }
            Ev::CaptureClosed(generation) => {
                if generation == self.generation && self.capturing {
                    self.on_monitor_lost();
                }
            }
        }
    }

    fn write(&mut self, line: &Line) {
        if let Err(e) = self.journal.write(line) {
            log(format_args!("can't write the screen journal: {e}"));
        }
    }

    /// Meeting time now, never backward.
    fn now_t(&mut self) -> u64 {
        self.clock.at(clockwin::now()).unwrap_or(0)
    }

    // ---- capture -------------------------------------------------------------------------

    fn make_device(&mut self) -> windows::core::Result<D3D> {
        if self.create_failures > 0 {
            self.create_failures -= 1;
            return Err(windows::core::Error::new(
                windows::Win32::Graphics::Dxgi::DXGI_ERROR_DEVICE_REMOVED,
                "device-lost-at test switch",
            ));
        }
        let warp = self.test.as_ref().is_some_and(|t| t.warp);
        if self.no_video_devices > 0 {
            self.no_video_devices -= 1;
            log("no-video-device test switch: a graphics device without video support");
            return d3d::create(false, warp);
        }
        d3d::create(self.mode == Mode::Video && self.drops.video.is_none(), warp)
    }

    /// Whether a new graphics device must have video support: the video still records and
    /// this computer gave the process such a device before. `d3d::create` falls back to a
    /// device without it, which suits frames only, and to WARP, which never has it; after a lost
    /// device that fallback mustn't count as a recovery while the video needs the real one
    /// (spec 2.5).
    fn needs_video_device(&self) -> bool {
        self.mode == Mode::Video && self.drops.video.is_none() && self.had_video_device
    }

    fn try_start(&mut self) -> Result<(), StartFail> {
        if self.d3d.is_none() {
            let device = self.make_device()?;
            let kind = match (device.warp, device.video) {
                (true, _) => "WARP",
                (false, true) => "GPU with video support",
                (false, false) => "GPU",
            };
            if self.needs_video_device() && !device.video {
                log(format_args!(
                    "graphics device: {kind}, without the video support the video needs"
                ));
                return Err(StartFail::NoVideo);
            }
            log(format_args!("graphics device: {kind}"));
            self.had_video_device |= device.video;
            self.d3d = Some(device);
            self.source = None;
            self.thumbs = None;
        }
        let device = self.d3d.clone().ok_or_else(windows::core::Error::empty)?;
        if self.source.is_none() {
            self.source = Some(match &self.test {
                Some(spec) => Box::new(synthetic::new(device, self.events.clone(), spec)),
                None => Box::new(wgc::new(device, self.events.clone())),
            });
        }
        self.generation += 1;
        let generation = self.generation;
        let monitor = self.monitor.clone();
        if let Some(source) = self.source.as_mut() {
            source.start(&monitor, generation)?;
        }
        self.capturing = true;
        self.awaiting_capture = true;
        self.saver.reset();
        self.last = None;
        Ok(())
    }

    /// Starts capturing unless paused, locked, stopping or with nothing left to record.
    fn start_capture(&mut self) {
        if self.capturing
            || self.paused
            || self.locked
            || self.stop.is_some()
            || self.drops.all_dropped()
        {
            return;
        }
        match self.try_start() {
            Ok(()) => {}
            // Only a device without video support came: recover as from a lost device, which
            // tries again and drops the video when the retries are spent.
            Err(StartFail::NoVideo) => self.on_device_lost(),
            Err(StartFail::Windows(e)) => {
                if is_device_lost(&e) && self.d3d.is_some() {
                    self.on_device_lost();
                    return;
                }
                log(format_args!(
                    "can't capture {}: {:#010x} {}",
                    self.monitor.id,
                    e.code().0,
                    e.message()
                ));
                self.capture_retry_at = Some(Instant::now() + CAPTURE_RETRY);
            }
        }
    }

    fn stop_capture(&mut self) {
        if let Some(source) = self.source.as_mut() {
            source.stop();
        }
        self.capturing = false;
        self.generation += 1;
        self.last = None;
    }

    /// Drops the device and everything on it.
    fn release_device(&mut self) {
        self.stop_capture();
        self.source = None;
        self.thumbs = None;
        self.d3d = None;
    }

    fn write_monitor(&mut self, reason: &str) {
        let t = self.now_t();
        let m = self.monitor.clone();
        self.write(&Line::Monitor {
            t,
            id: m.id,
            name: m.name,
            width: m.width,
            height: m.height,
            primary: m.primary,
            reason: reason.into(),
        });
    }

    /// The monitors this process may record: every one, or with `--monitor` only that one. So
    /// a pinned process never moves to another monitor: not on request, and not when its own
    /// goes away, when it waits for it to come back (spec 2.7).
    fn monitors(&mut self, fresh: bool) -> Vec<MonitorInfo> {
        if fresh || self.monitor_cache.0.elapsed() >= MONITOR_CACHE {
            self.monitor_cache = (Instant::now(), list_monitors(self.test.as_ref()));
        }
        let mut list = self.monitor_cache.1.clone();
        if let Some(at) = self.test.as_ref().and_then(|t| t.monitor_gone_at_ms) {
            if self.now_t() >= at && !list.is_empty() {
                list.remove(0);
            }
        }
        match &self.pinned {
            Some(id) => list.into_iter().filter(|m| &m.id == id).collect(),
            None => list,
        }
    }

    fn switch_monitor(&mut self, id: &str, reason: &str) -> Result<String, &'static str> {
        if self.stop.is_some() || self.drops.all_dropped() {
            return Err("stopped");
        }
        let list = self.monitors(true);
        let Some(next) = list.iter().find(|m| m.id == id).cloned() else {
            return Err("unknown_monitor");
        };
        if next.id == self.monitor.id && reason == "user" {
            return Ok(next.id);
        }
        self.end_video("monitor");
        self.stop_capture();
        self.monitor = next;
        log(format_args!("moved to {} ({reason})", self.monitor.id));
        self.write_monitor(reason);
        self.start_capture();
        Ok(self.monitor.id.clone())
    }

    fn on_monitor_lost(&mut self) {
        let list = self.monitors(true);
        if list.iter().any(|m| m.id == self.monitor.id) {
            // Still there, as after a mode change: capture it again.
            self.end_video("resize");
            self.stop_capture();
            self.start_capture();
            return;
        }
        let next = match &self.test {
            Some(_) => list.first().map(|m| m.id.clone()),
            None => monitors::choose(
                &monitors_win::z_order(),
                monitors_win::cursor_monitor().as_deref(),
                &list,
            ),
        };
        match next {
            Some(id) => {
                let _ = self.switch_monitor(&id, "lost");
            }
            // No monitor, or a pinned one that went away: wait until it is back.
            None => {
                if self.capturing {
                    log(format_args!("{} is gone; waiting for it", self.monitor.id));
                }
                self.end_video("monitor");
                self.stop_capture();
                self.capture_retry_at = Some(Instant::now() + CAPTURE_RETRY);
            }
        }
    }

    fn on_device_lost(&mut self) {
        if self.recovering {
            return;
        }
        self.recovering = true;
        let t = self.now_t();
        log("the graphics device was lost");
        self.end_video("error");
        self.write(&Line::DeviceLost { t });
        self.release_device();
        // The policy counts this loss and every failed recreation; after `DEVICE_RETRIES`
        // failures it drops the video, then the frames, one step per call (spec 2.6). Each loss
        // gets a count of its own, so a device that came back doesn't bring a later loss closer
        // to a drop: the episode starts from the drops made so far. A device without the video
        // support the video needs counts as a failed recreation for the video only: once the
        // video is dropped, the frames go on with such a device.
        let mut episode = DropState::new(self.mode == Mode::Video);
        episode.video = self.drops.video;
        episode.frames = self.drops.frames;
        let mut step = episode.on_device_lost();
        let mut without_video = false;
        for _ in 0..16 {
            match step {
                EncoderStep::Retry => {
                    if self.stop.is_some() || self.paused || self.locked {
                        // `resume`, `unlock` or the stop take it from here.
                        break;
                    }
                    match self.try_start() {
                        Ok(()) => break,
                        Err(StartFail::NoVideo) => {
                            without_video = true;
                            self.release_device();
                            std::thread::sleep(DEVICE_RETRY_PAUSE);
                            step = episode.on_device_without_video();
                        }
                        Err(StartFail::Windows(e)) => {
                            log(format_args!(
                                "recreating the graphics device failed: {:#010x}",
                                e.code().0
                            ));
                            self.release_device();
                            std::thread::sleep(DEVICE_RETRY_PAUSE);
                            step = episode.on_device_lost();
                        }
                    }
                }
                EncoderStep::Drop(part, reason) => {
                    match part {
                        Part::Video => self.drops.video = Some(reason),
                        Part::Frames => self.drops.frames = Some(reason),
                    }
                    self.apply_drop(part, reason);
                    step = if without_video {
                        episode.on_device_without_video()
                    } else {
                        episode.on_device_lost()
                    };
                }
                EncoderStep::Ignore => break,
            }
        }
        self.recovering = false;
    }

    fn rebuild_device(&mut self) {
        log("starting over with a new graphics device");
        self.release_device();
        self.start_capture();
    }

    // ---- frames --------------------------------------------------------------------------

    fn on_frame(&mut self, frame: CapturedFrame) {
        if frame.generation != self.generation
            || !self.capturing
            || self.paused
            || self.locked
            || self.stop.is_some()
        {
            return;
        }
        let now = clockwin::at_boot(frame.boot);
        let Some(t) = self.clock.at(now) else {
            return;
        };
        if self.awaiting_capture {
            self.awaiting_capture = false;
            self.captured = true;
            let line = Line::Capture {
                t,
                wall: now.wall,
                monitor: self.monitor.id.clone(),
                width: frame.width,
                height: frame.height,
            };
            self.write(&line);
        }
        if let Some(at) = self.device_fault_at {
            if t >= at {
                self.device_fault_at = None;
                self.create_failures = self
                    .test
                    .as_ref()
                    .map_or(0, |spec| spec.device_create_failures);
                self.no_video_devices = self.test.as_ref().map_or(0, |spec| spec.no_video_devices);
                log("device-lost-at test switch: the graphics device is gone");
                self.on_device_lost();
                return;
            }
        }
        self.video_frame(&frame, t);
        self.frames_frame(frame, t);
    }

    fn frames_frame(&mut self, frame: CapturedFrame, t: u64) {
        if self.drops.frames.is_some() {
            return;
        }
        let now = Instant::now();
        let still = frame.dirty.is_some_and(|d| d < DIRTY_SKIP);
        let previous = self.last.as_ref().and_then(|l| l.thumb.clone());
        let thumb = if still && previous.is_some() {
            previous
        } else if self.last_thumb_at.is_none_or(|at| now - at >= THUMB_GAP) {
            self.last_thumb_at = Some(now);
            self.thumb(&frame)
        } else {
            None
        };
        self.last = Some(Last {
            frame: frame.clone(),
            thumb: thumb.clone(),
            offered_t: t,
        });
        if let Some(thumb) = thumb {
            if self.saver.offer(t, &thumb, frame.dirty) == Decision::Save {
                self.save(&frame, t, thumb);
            }
        }
    }

    fn thumb(&mut self, frame: &CapturedFrame) -> Option<Thumb> {
        let d3d = self.d3d.clone()?;
        if self
            .thumbs
            .as_ref()
            .is_none_or(|t| t.size() != (frame.width, frame.height))
        {
            match Thumbnailer::new(&d3d, frame.width, frame.height) {
                Ok(thumbs) => self.thumbs = Some(thumbs),
                Err(e) => {
                    self.graphics_failed(&e, "thumbnail");
                    return None;
                }
            }
        }
        match self.thumbs.as_mut()?.thumb(&frame.texture) {
            Ok(thumb) => Some(thumb),
            Err(e) => {
                self.graphics_failed(&e, "thumbnail");
                None
            }
        }
    }

    fn graphics_failed(&mut self, e: &windows::core::Error, what: &str) {
        if is_device_lost(e) || self.d3d.as_ref().is_some_and(D3D::removed) {
            self.on_device_lost();
        } else {
            log(format_args!("{what} failed: {:#010x}", e.code().0));
        }
    }

    /// Offers the last frame again while the screen is still, so a change that settled saves.
    fn reoffer(&mut self) {
        if !self.capturing || self.paused || self.locked || self.drops.frames.is_some() {
            return;
        }
        let t = self.now_t();
        let Some(last) = self.last.as_ref() else {
            return;
        };
        if t < last.offered_t + REOFFER_MS {
            return;
        }
        let frame = last.frame.clone();
        let thumb = match last.thumb.clone() {
            Some(thumb) => Some(thumb),
            None => self.thumb(&frame),
        };
        let Some(thumb) = thumb else {
            return;
        };
        if let Some(last) = self.last.as_mut() {
            last.thumb = Some(thumb.clone());
            last.offered_t = t;
        }
        if self.saver.offer(t, &thumb, None) == Decision::Save {
            self.save(&frame, t, thumb);
        }
    }

    fn save(&mut self, frame: &CapturedFrame, t: u64, thumb: Thumb) {
        if self.drops.frames.is_some() {
            return;
        }
        let id = paths::frame_id(t);
        if self.last_frame_id.as_deref() == Some(id.as_str()) {
            return;
        }
        let Some(d3d) = self.d3d.clone() else {
            return;
        };
        match jpeg::pixels(&d3d, frame) {
            Ok(pixels) => {
                self.worker.send(FrameJob {
                    id: id.clone(),
                    t,
                    pixels,
                });
                self.saver.saved(t, thumb);
                self.last_frame_id = Some(id);
            }
            Err(e) => self.graphics_failed(&e, "reading a frame"),
        }
    }

    fn on_frame_done(&mut self, done: FrameDone) {
        match done {
            FrameDone::Saved(line) => {
                let Line::Frame { t, file, .. } = &line else {
                    return;
                };
                let after_pause = self.paused && self.pause_from.is_some_and(|p| *t >= p);
                let after_stop = self.stop_t.is_some_and(|s| *t > s);
                if self.drops.frames.is_some() || after_pause || after_stop {
                    let _ = fs::remove_file(self.dir.join(file));
                    return;
                }
                self.write(&line);
                self.frames_saved += 1;
            }
            FrameDone::Failed {
                id,
                disk_full,
                error,
                ..
            } => {
                log(format_args!("frame {id} wasn't saved: {error}"));
                if disk_full {
                    self.disk_full(Part::Frames);
                }
            }
        }
    }

    // ---- video ---------------------------------------------------------------------------

    fn video_wanted(&self) -> bool {
        self.mode == Mode::Video
            && self.drops.video.is_none()
            && self.rebuild_at.is_none()
            && !self.paused
            && !self.locked
            && self.stop.is_none()
    }

    fn video_frame(&mut self, frame: &CapturedFrame, t: u64) {
        if !self.video_wanted() {
            return;
        }
        if let Some(video) = &self.video {
            if (video.width, video.height) != (frame.width, frame.height) {
                self.end_video("resize");
            }
        }
        if self.video.is_none() {
            self.start_video(frame, t);
        }
        if let Some(video) = &self.video {
            video.send(frame.texture.clone(), frame.boot);
        }
    }

    fn next_video_seq(&self) -> u64 {
        self.video_seq.max(finalize::highest_video_seq(&self.dir)) + 1
    }

    fn start_video(&mut self, frame: &CapturedFrame, t: u64) {
        let Some(mf) = mf::shared() else {
            self.drop_video_encoder("Media Foundation isn't available");
            return;
        };
        let Some(d3d) = self.d3d.clone() else {
            return;
        };
        let seq = self.next_video_seq();
        let file = paths::video_file(seq);
        let test = self.test.clone().unwrap_or_default();
        let options = WriterOptions {
            allow_software: test.software_encoder,
            no_hardware: test.no_hardware,
            start_t: t,
            encoder_fail_at: test.encoder_fail_at_ms,
            disk_fail_at: match test.write_fail {
                Some((Part::Video, at)) => Some(at),
                _ => None,
            },
        };
        let start = VideoStart {
            mf,
            d3d,
            path: self.dir.join(&file),
            file: file.clone(),
            seq,
            width: frame.width,
            height: frame.height,
            options,
        };
        match video_thread::start(start, self.events.clone()) {
            Ok(video) => {
                self.video_seq = seq;
                log(format_args!(
                    "video {seq}: {} ({}), {}x{}",
                    video.encoder,
                    if video.hardware {
                        "hardware"
                    } else {
                        "software"
                    },
                    video.video_width,
                    video.video_height
                ));
                let line = Line::Video {
                    t,
                    seq,
                    file,
                    width: video.video_width,
                    height: video.video_height,
                    fps: FPS,
                    encoder: video.encoder.clone(),
                    hardware: video.hardware,
                };
                self.write(&line);
                self.encoder = Some((video.encoder.clone(), video.hardware));
                self.video = Some(video);
            }
            Err(VideoError::Software) => self.drop_video_encoder("no hardware H.264 encoder runs"),
            Err(VideoError::Disk(e)) => {
                log(format_args!(
                    "can't start video {seq}: the disk is full ({e})"
                ));
                self.disk_full(Part::Video);
            }
            Err(VideoError::DeviceLost) => self.on_device_lost(),
            Err(VideoError::Encoder(e)) => {
                log(format_args!("can't start video {seq}: {e}"));
                self.encoder_failed();
            }
        }
    }

    /// Ends the open video file and writes its `video_end`. A file that couldn't be finished on
    /// a full disk drops the video, unless the disk is why it ended.
    fn end_video(&mut self, reason: &str) {
        let Some(video) = self.video.take() else {
            return;
        };
        let (seq, start, path) = (video.seq, video.t, video.path.clone());
        // Read after the thread wrote the frames still queued, so `video_end` covers them.
        let (result, end) = video.end(FINISH_WAIT);
        let bytes = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        self.write(&Line::VideoEnd {
            t: end.max(start),
            seq,
            reason: reason.into(),
            bytes,
        });
        self.video_bytes_closed += bytes;
        match result {
            Ok(_) => {}
            Err(VideoError::Disk(e)) if reason != "disk" && self.stop.is_none() => {
                log(format_args!("video {seq} ended on a full disk: {e}"));
                self.disk_full(Part::Video);
            }
            Err(e) => log(format_args!("video {seq} ended badly: {e}")),
        }
    }

    fn on_video_error(&mut self, seq: u64, error: VideoError) {
        if self.video.as_ref().is_none_or(|v| v.seq != seq) {
            return;
        }
        log(format_args!("video {seq}: {error}"));
        match error {
            VideoError::Disk(_) => {
                self.end_video("disk");
                self.disk_full(Part::Video);
            }
            VideoError::Encoder(_) => {
                self.end_video("error");
                self.encoder_failed();
            }
            VideoError::Software => {
                self.end_video("error");
                self.drop_video_encoder("only a software encoder runs");
            }
            VideoError::DeviceLost => self.on_device_lost(),
        }
    }

    fn encoder_failed(&mut self) {
        match self.drops.on_encoder_error() {
            EncoderStep::Retry => {
                self.rebuild_at = Some(Instant::now() + Duration::from_millis(ENCODER_RETRY_MS));
            }
            EncoderStep::Drop(part, reason) => self.apply_drop(part, reason),
            EncoderStep::Ignore => {}
        }
    }

    /// No encoder at all: no hardware one, or Media Foundation missing. Frames go on.
    fn drop_video_encoder(&mut self, why: &str) {
        // No encoder to retry: the policy's second encoder error drops the video.
        for _ in 0..2 {
            match self.drops.on_encoder_error() {
                EncoderStep::Retry => continue,
                EncoderStep::Drop(part, reason) => {
                    log(format_args!("recording frames only: {why}"));
                    self.apply_drop(part, reason);
                }
                EncoderStep::Ignore => {}
            }
            break;
        }
    }

    // ---- drops ---------------------------------------------------------------------------

    fn disk_full(&mut self, part: Part) {
        for (part, reason) in self.drops.on_disk_full(part) {
            self.apply_drop(part, reason);
        }
    }

    fn check_disk(&mut self) {
        let test_file = self.test.as_ref().and_then(|t| t.free_bytes_file.clone());
        let every = match test_file {
            Some(_) => TEST_DISK_CHECK,
            None => Duration::from_millis(DISK_CHECK_MS),
        };
        self.next_disk_check = Instant::now() + every;
        let Some(free) = crate::disk::free_bytes(&self.dir, test_file.as_deref()) else {
            return;
        };
        for (part, reason) in self.drops.on_free_bytes(free) {
            self.apply_drop(part, reason);
        }
    }

    /// Journals a drop the policy decided: video first, its file ended before the line.
    fn apply_drop(&mut self, part: Part, reason: Reason) {
        match part {
            Part::Video => self.end_video(if reason == Reason::Disk {
                "disk"
            } else {
                "error"
            }),
            Part::Frames => self.worker.clear(),
        }
        let t = self.now_t();
        log(format_args!(
            "dropped {}: {}",
            part.as_str(),
            reason.as_str()
        ));
        self.write(&Line::Dropped {
            t,
            what: part.as_str().into(),
            reason: reason.as_str().into(),
        });
        if self.drops.all_dropped() {
            self.request_stop(t, "dropped", None);
        }
    }

    // ---- the recorder's timeline, pause, lock -------------------------------------------

    fn follow_timeline(&mut self) {
        let lines = match self.follower.poll() {
            Ok(lines) => lines,
            Err(e) => {
                log(format_args!("can't read the timeline: {e}"));
                return;
            }
        };
        if !lines.is_empty() {
            self.last_activity = clockwin::awake_100ns();
        }
        for line in lines {
            match &line {
                TimelineLine::Session { .. } | TimelineLine::Heartbeat { .. } => {
                    if let Fed::Reanchored { jump_ms } = self.clock.feed(&line, clockwin::now()) {
                        if jump_ms.abs() > REANCHOR_SPLIT_MS {
                            log(format_args!("the recorder's clock moved {jump_ms} ms"));
                            self.end_video("clock");
                        }
                    }
                }
                TimelineLine::Pause { t } => {
                    self.timeline_paused = true;
                    self.pause(Some(*t));
                }
                TimelineLine::Resume { .. } => {
                    self.timeline_paused = false;
                    self.resume();
                }
                TimelineLine::Suspend { .. } => self.saver.reset(),
                TimelineLine::Stop { t, .. } => self.request_stop(*t, "meeting", None),
                _ => {}
            }
        }
    }

    fn pause(&mut self, t: Option<u64>) {
        let t = match t {
            Some(t) => t,
            None => self.now_t(),
        };
        self.pause_from = Some(self.pause_from.map_or(t, |p| p.min(t)));
        self.worker.cancel_from(t);
        if self.paused {
            return;
        }
        self.paused = true;
        self.end_video("pause");
        self.stop_capture();
    }

    fn resume(&mut self) {
        if !self.paused {
            return;
        }
        self.paused = false;
        self.pause_from = None;
        self.start_capture();
    }

    fn check_lock(&mut self) {
        self.next_lock_check = Instant::now() + LOCK_CHECK;
        let locked = session::locked();
        if locked == self.locked {
            return;
        }
        let t = self.now_t();
        if locked {
            log("the session locked");
            self.end_video("lock");
            self.stop_capture();
            self.locked = true;
            self.write(&Line::Lock { t });
        } else {
            log("the session unlocked");
            self.locked = false;
            self.write(&Line::Unlock { t });
            // A capture bound across a lock can stay blank; a new session doesn't.
            self.source = None;
            self.start_capture();
        }
    }

    // ---- the loop ------------------------------------------------------------------------

    fn tick(&mut self) {
        self.follow_timeline();
        if self.stop.is_some() {
            return;
        }
        let now = Instant::now();
        if now >= self.next_heartbeat {
            self.next_heartbeat = now + HEARTBEAT;
            self.heartbeat();
        }
        if now >= self.next_disk_check {
            self.check_disk();
        }
        if self.test.is_none() && now >= self.next_lock_check {
            self.check_lock();
        }
        if self.rebuild_at.is_some_and(|at| now >= at) {
            self.rebuild_at = None;
            self.rebuild_device();
        }
        if self.capture_retry_at.is_some_and(|at| now >= at) {
            self.capture_retry_at = None;
            if self.monitors(true).iter().any(|m| m.id == self.monitor.id) {
                self.start_capture();
            } else {
                // The monitor went away while capture was down: choose again.
                self.on_monitor_lost();
            }
        }
        if self.capturing && self.d3d.as_ref().is_some_and(D3D::removed) {
            self.on_device_lost();
        }
        // The capture's `Closed` notice shares the queue with frames and is lost when the queue
        // is full, so a recorded monitor that left the list counts as gone as well.
        if self.capturing && !self.monitors(false).iter().any(|m| m.id == self.monitor.id) {
            log(format_args!("{} left the monitor list", self.monitor.id));
            self.on_monitor_lost();
        }
        if let Some(video) = &self.video {
            video.tick(clockwin::boot_100ns());
        }
        self.reoffer();
        if now >= self.next_memory_log {
            self.next_memory_log = now + MEMORY_LOG;
            if crate::dev_mode() {
                if let Some(bytes) = self.d3d.as_ref().and_then(D3D::memory_in_use) {
                    let dropped = self.video.as_ref().map_or(0, VideoThread::dropped);
                    log(format_args!(
                        "gpu memory in use: {} MB; frames saved: {}; video frames the encoder dropped: {dropped}",
                        bytes >> 20,
                        self.frames_saved
                    ));
                }
            }
        }
        let awake = clockwin::awake_100ns();
        if awake.saturating_sub(self.last_activity) >= self.orphan_100ns
            && awake.saturating_sub(self.last_status) >= self.orphan_100ns
        {
            log("the recorder has been silent too long; stopping");
            let t = self.now_t();
            self.request_stop(t, "interrupted", None);
        }
    }

    fn heartbeat(&mut self) {
        let now = clockwin::now();
        let t = self.clock.at(now).unwrap_or(0);
        let open = self
            .video
            .as_ref()
            .and_then(|v| fs::metadata(&v.path).ok())
            .map_or(0, |m| m.len());
        let line = Line::Heartbeat {
            t,
            wall: now.wall,
            boot: now.boot,
            frames: self.frames_saved,
            video_bytes: self.video_bytes_closed + open,
        };
        self.write(&line);
        self.journal.sync();
    }

    fn request_stop(&mut self, t: u64, reason: &str, reply: Option<Sender<Value>>) {
        match &mut self.stop {
            Some(stopping) => stopping.replies.extend(reply),
            None => {
                self.stop = Some(Stopping {
                    t,
                    reason: reason.into(),
                    replies: reply.into_iter().collect(),
                })
            }
        }
    }

    /// Stops capturing, ends the video, lets OCR finish, writes `stop`, removes `screen.json`
    /// and only then answers a `stop` request.
    fn finish(&mut self, rx: &Receiver<Ev>) {
        let stopping = self.stop.take().unwrap_or(Stopping {
            t: 0,
            reason: "interrupted".into(),
            replies: Vec::new(),
        });
        let mut replies = stopping.replies;
        self.stop_t = Some(stopping.t);
        // Stopping: new frames and requests are refused from here on.
        self.stop = Some(Stopping {
            t: stopping.t,
            reason: stopping.reason.clone(),
            replies: Vec::new(),
        });
        self.release_device();
        self.end_video("stop");
        if self.drops.frames.is_none() {
            let started = Instant::now();
            while self.worker.pending() > 0 {
                let waited = started.elapsed();
                if waited >= DRAIN_WAIT {
                    self.worker.skip_ocr();
                }
                if waited >= DRAIN_WAIT + DRAIN_EXTRA {
                    log("frames still waiting at the stop are left out");
                    break;
                }
                if let Ok(event) = rx.recv_timeout(Duration::from_millis(50)) {
                    self.handle_stopping(event, &mut replies);
                }
            }
            for event in rx.try_iter().collect::<Vec<_>>() {
                self.handle_stopping(event, &mut replies);
            }
        } else {
            self.worker.clear();
        }
        self.write(&Line::Stop {
            t: stopping.t,
            reason: stopping.reason.clone(),
        });
        self.journal.sync();
        screenfile::remove(&self.dir);
        log(format_args!(
            "session {}: stopped at {} ({}), {} frames",
            self.session, stopping.t, stopping.reason, self.frames_saved
        ));
        for reply in replies {
            let _ = reply.send(json!({ "ok": true, "t": stopping.t }));
        }
        // Frames still queued are left out. A JPEG the worker finishes after the stop line has
        // no line to name it, and `finalize` doesn't look at a stopped journal: remove it.
        self.worker.clear();
        self.worker.join(WORKER_JOIN);
        for event in rx.try_iter() {
            if let Ev::FrameDone(FrameDone::Saved(Line::Frame { file, .. })) = event {
                let _ = fs::remove_file(self.dir.join(file));
            }
        }
    }

    fn handle_stopping(&mut self, event: Ev, replies: &mut Vec<Sender<Value>>) {
        match event {
            Ev::FrameDone(done) => self.on_frame_done(done),
            Ev::Control(request) => match request.body["cmd"].as_str() {
                Some("stop") => replies.push(request.reply),
                Some("status") => {
                    let status = self.status();
                    let _ = request.reply.send(status);
                }
                _ => {
                    let _ = request.reply.send(error("stopped"));
                }
            },
            _ => {}
        }
    }

    // ---- control port --------------------------------------------------------------------

    fn on_control(&mut self, request: Request) {
        let reply = match request.body["cmd"].as_str() {
            Some("status") => {
                self.last_status = clockwin::awake_100ns();
                self.status()
            }
            Some("monitors") => {
                let list = monitors::ordered(&self.monitors(true));
                json!({ "ok": true, "monitors": list })
            }
            Some("monitor") => match request.body["id"].as_str() {
                Some(id) => match self.switch_monitor(id, "user") {
                    Ok(id) => json!({ "ok": true, "monitor": id }),
                    Err(code) => error(code),
                },
                None => error("bad_request"),
            },
            Some("pause") => {
                self.pause(None);
                json!({ "ok": true })
            }
            // The fast path for a pause, which mustn't wait for the timeline. A resume reads the
            // timeline first and counts only when the timeline says resumed: a resume the
            // supervisor sent late, after a newer pause, mustn't record through that pause.
            Some("resume") => {
                self.follow_timeline();
                if !self.timeline_paused {
                    self.resume();
                }
                json!({ "ok": true })
            }
            Some("stop") => {
                let t = self.now_t();
                self.request_stop(t, "meeting", Some(request.reply));
                return;
            }
            Some(_) => error("unknown_command"),
            None => error("bad_request"),
        };
        let _ = request.reply.send(reply);
    }

    /// The `status` reply as `voice/RECORDING.md` "The screen control port" describes it.
    fn status(&mut self) -> Value {
        let t = self.now_t();
        let state = if self.stop.is_some() {
            "stopped"
        } else if self.paused {
            "paused"
        } else if self.locked {
            "locked"
        } else if !self.captured {
            "starting"
        } else {
            "recording"
        };
        let monitors = monitors::ordered(&self.monitors(false));
        json!({
            "ok": true,
            "state": state,
            "t": t,
            "mode": self.mode.as_str(),
            "video": self.mode == Mode::Video && self.drops.video.is_none(),
            "frames": self.drops.frames.is_none(),
            "monitor": self.monitor.id,
            "monitors": monitors,
            "dropped": {
                "video": self.drops.video.map(Reason::as_str),
                "frames": self.drops.frames.map(Reason::as_str),
            },
            "encoder": self.encoder.as_ref().map(|(name, _)| name.as_str()),
            "hardware": self.encoder.as_ref().map(|(_, hardware)| *hardware),
            "saved": self.frames_saved,
        })
    }
}

fn error(code: &str) -> Value {
    json!({ "ok": false, "error": code })
}

/// Handles up to `max` events still queued. `running` is checked before each one leaves the
/// queue, so an event queued behind a stop stays there for `finish` to drain: one taken after
/// the stop would be lost, a frame without its `frame` line or a request without an answer.
fn handle_queued<S, T>(
    rx: &Receiver<T>,
    max: usize,
    state: &mut S,
    running: impl Fn(&S) -> bool,
    mut handle: impl FnMut(&mut S, T),
) {
    for _ in 0..max {
        if !running(state) {
            return;
        }
        let Ok(event) = rx.try_recv() else {
            return;
        };
        handle(state, event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_behind_a_stop_stay_queued() {
        let (tx, rx) = mpsc::channel();
        for event in 0..4 {
            tx.send(event).unwrap();
        }
        // Event 1 stops the loop: 2 and 3 are left for the drain.
        let mut handled: Vec<u32> = Vec::new();
        handle_queued(
            &rx,
            EVENT_QUEUE,
            &mut handled,
            |h| !h.contains(&1),
            |h, e| h.push(e),
        );
        assert_eq!(handled, [0, 1]);
        assert_eq!(rx.try_iter().collect::<Vec<_>>(), [2, 3]);

        // Stopped already: nothing leaves the queue.
        tx.send(4).unwrap();
        handle_queued(&rx, EVENT_QUEUE, &mut handled, |_| false, |h, e| h.push(e));
        assert_eq!(rx.try_iter().collect::<Vec<_>>(), [4]);

        // At most `max` a round, so the tick still runs under a flood of frames.
        for event in 0..10 {
            tx.send(event).unwrap();
        }
        let mut count = 0;
        handle_queued(&rx, 3, &mut count, |_| true, |c, _| *c += 1);
        assert_eq!(count, 3);
        assert_eq!(rx.try_iter().count(), 7);
    }
}
