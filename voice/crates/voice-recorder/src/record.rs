//! `record`: the recorder thread. It alone writes the timeline and the segments; capture
//! callbacks and control connections only send it events.

use std::collections::BTreeMap;
use std::fmt::Display;
use std::fs;
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use voice_audio::{Resampler, SegmentWriter, SAMPLE_RATE};

use crate::clock::{self, wall_ms, MeetingClock, HEARTBEAT};
use crate::control::{self, Command, Reply};
use crate::meeting::{self, RecorderFile};
use crate::source::{Backend, Capture, DeviceInfo, Failure, Sink, SourceSpec, StreamFlags};
use crate::timeline::{self, samples_to_ms, History, Line, TimelineWriter};
use crate::{token, ExitError, VERSION};

/// A meeting stops by itself after 8 hours.
pub const DEFAULT_LIMIT_MS: u64 = 8 * 60 * 60 * 1000;
/// A new segment starts every 30 s of audio.
pub const DEFAULT_SEGMENT_MS: u64 = 30_000;
const SAMPLES_PER_MS: u64 = SAMPLE_RATE as u64 / 1000;
/// Pending audio goes to disk on every tick, or sooner when this much has piled up, so an
/// append is 100 to 200 ms of audio.
const TICK: Duration = Duration::from_millis(100);
const APPEND_SAMPLES: usize = 2 * 1_600;
/// A healthy loopback track is padded once it trails the clock by this much (Ownkey's
/// PAD_THRESHOLD_SECONDS).
const PAD_THRESHOLD_MS: u64 = 500;
const RETRY: Duration = Duration::from_secs(1);
const DEFAULT_POLL: Duration = Duration::from_secs(2);
const SYNC: Duration = Duration::from_secs(5);
/// A microphone delivers blocks continuously, even of silence; one that stops is gone.
const STALL: Duration = Duration::from_secs(5);
/// A continuing stream's next segment starts where the previous one ended, unless the device's
/// clock has drifted this far from the meeting clock.
const RESYNC_MS: u64 = 100;
/// About 20 s of 10 ms blocks from two tracks.
const EVENT_QUEUE: usize = 4_096;

#[derive(Debug)]
pub struct RecordOptions {
    pub meeting: PathBuf,
    pub resume: bool,
    pub tracks: Vec<(String, SourceSpec)>,
    pub limit_ms: u64,
    /// Segment length; only tests change it.
    pub segment_ms: u64,
}

pub(crate) enum Event {
    Audio {
        track: usize,
        generation: u64,
        at: Instant,
        data: Vec<f32>,
    },
    Failed {
        track: usize,
        generation: u64,
    },
    Command {
        command: Command,
        reply: Sender<Reply>,
        /// When the control port received it.
        at: Instant,
    },
}

/// Samples of silence a track needs so its audio reaches `now_ms`; `covered_end` is where its
/// audio ends, in samples since meeting time 0.
///
/// Only a loopback endpoint gets padding: it delivers nothing while nothing plays, and real
/// silence must keep the call track aligned with the microphone (Ownkey `capture.py:414-418`).
/// It stops the moment the device reports an error, and a pause records nothing.
pub fn padding(
    loopback: bool,
    healthy: bool,
    paused: bool,
    covered_end: u64,
    now_ms: u64,
    threshold_ms: u64,
) -> u64 {
    if !loopback || !healthy || paused {
        return 0;
    }
    let deficit = (now_ms * SAMPLES_PER_MS).saturating_sub(covered_end);
    if deficit > threshold_ms * SAMPLES_PER_MS {
        deficit
    } else {
        0
    }
}

/// Where the next segment of a continuing stream starts: right after the previous one, unless
/// the device's clock drifted more than `RESYNC_MS` from the meeting clock's estimate.
pub fn next_segment_start(contiguous: u64, estimate: u64) -> u64 {
    if contiguous.abs_diff(estimate) > RESYNC_MS {
        estimate
    } else {
        contiguous
    }
}

/// Records until `stop`, the length limit or a kill.
pub fn record(opts: RecordOptions) -> Result<(), ExitError> {
    let dir = opts.meeting;
    if !dir.is_dir() {
        return Err(ExitError::usage(format!(
            "meeting folder {} doesn't exist",
            dir.display()
        )));
    }
    if meeting::live_recorder(&dir).is_some() {
        return Err(ExitError::busy());
    }
    let lines = timeline::read(&meeting::timeline_path(&dir))
        .map_err(|e| ExitError::failed(format!("can't read the timeline: {e}")))?;
    let history = History::from_lines(&lines);
    if !history.is_empty() && !opts.resume {
        return Err(ExitError::conflict(
            "the meeting already has a recording; continue it with --resume",
        ));
    }
    if history.stopped {
        return Err(ExitError::conflict(
            "the meeting's recording has stopped; nothing can follow its stop line",
        ));
    }
    let mut journal = Journal(meeting::open_timeline(&dir)?);
    for (name, _) in &opts.tracks {
        fs::create_dir_all(dir.join("audio").join(name))
            .map_err(|e| ExitError::failed(format!("can't create the audio folder: {e}")))?;
    }

    // A resumed session first closes what the dead one left open, so every segment ends.
    let resumed = !history.is_empty();
    let mut problems = Vec::new();
    let repaired = meeting::repair_segments(&dir, history.open_segments(), &mut problems);
    for problem in problems {
        log(format_args!("previous session: {problem}"));
    }
    for s in history.open_segments() {
        let samples = repaired[&(s.track.clone(), s.seq)];
        journal.write(Line::SegmentEnd {
            t: s.t + samples_to_ms(samples),
            track: s.track.clone(),
            seq: s.seq,
            samples,
        });
    }
    let last_seen = history.last_seen(|s| {
        repaired
            .get(&(s.track.clone(), s.seq))
            .copied()
            .or(s.ended)
            .unwrap_or(0)
    });

    let wall = wall_ms();
    let start_t = if resumed {
        let first_wall = history.first_wall.unwrap_or(wall);
        clock::resumed_start(first_wall, wall, history.latest_t.max(last_seen))
    } else {
        0
    };
    let listener = control::bind()
        .map_err(|e| ExitError::failed(format!("can't open the control port: {e}")))?;
    let port = listener
        .local_addr()
        .map_err(|e| ExitError::failed(e.to_string()))?
        .port();
    let token = token::new_token().map_err(|e| ExitError::failed(e.to_string()))?;
    let session = history.sessions + 1;
    // Set up the audio host before the clock starts, so the devices open close to the session
    // start.
    let backend = Backend::prepare();
    let clock = MeetingClock::starting_at(start_t);

    journal.write(Line::Session {
        t: start_t,
        wall,
        session,
        pid: std::process::id(),
        resumed,
        version: timeline::FORMAT_VERSION,
        recorder: VERSION.into(),
    });
    if resumed {
        journal.write(Line::Crash {
            t: start_t,
            last_seen,
        });
    }
    // The user paused before the previous recorder died; a restart must not record them.
    if history.paused {
        journal.write(Line::Pause { t: start_t });
    }
    journal.sync();
    meeting::write_recorder_file(
        &dir,
        &RecorderFile {
            pid: std::process::id(),
            port,
            token: token.clone(),
            session,
            started_at: wall,
        },
    )
    .map_err(|e| ExitError::failed(format!("can't write recorder.json: {e}")))?;

    let (events, rx) = mpsc::sync_channel(EVENT_QUEUE);
    control::spawn(listener, token, events.clone())
        .map_err(|e| ExitError::failed(format!("can't start the control thread: {e}")))?;

    let tracks = opts
        .tracks
        .into_iter()
        .map(|(name, spec)| Track {
            seq: history
                .last_seq(&name)
                .max(meeting::highest_seq_on_disk(&dir, &name)),
            name,
            spec,
            generation: 0,
            state: State::Lost {
                error: String::new(),
                next_try: Instant::now(),
            },
            device_id: None,
            segment: None,
            pending: Vec::new(),
            pending_end: start_t,
            covered_until: start_t,
            cover_from: None,
            taps: Vec::new(),
        })
        .collect();
    let mut recorder = Recorder {
        dir,
        journal,
        clock,
        backend,
        events,
        tracks,
        paused: history.paused,
        last_mark: history.last_mark,
        limit_ms: opts.limit_ms,
        segment_samples: opts.segment_ms.max(1) * SAMPLES_PER_MS,
        heartbeat: (start_t, wall),
        stop: None,
    };
    for i in 0..recorder.tracks.len() {
        if let Err(error) = recorder.try_open(i, false) {
            recorder.mark_lost(i, error);
        }
    }
    recorder.run(rx);
    Ok(())
}

fn log(message: impl Display) {
    let _ = writeln!(io::stderr(), "rukoo-voice-recorder: {message}");
}

/// The timeline, with write errors logged instead of stopping the recording: audio still goes
/// to disk, and `finalize` can complete the timeline later.
struct Journal(TimelineWriter);

impl Journal {
    fn write(&mut self, line: Line) {
        if let Err(e) = self.0.write(&line) {
            log(format_args!("can't write the timeline: {e}"));
        }
    }

    fn sync(&self) {
        if let Err(e) = self.0.sync() {
            log(format_args!("can't sync the timeline: {e}"));
        }
    }
}

struct Track {
    name: String,
    spec: SourceSpec,
    /// Counts opened streams; events from an earlier stream are ignored.
    generation: u64,
    state: State,
    /// The device the track opened last.
    device_id: Option<String>,
    /// The last segment number used.
    seq: u64,
    segment: Option<Segment>,
    /// Converted audio not yet appended to the segment.
    pending: Vec<i16>,
    /// Meeting time, by the clock, at which the last pending sample arrived.
    pending_end: u64,
    /// Where the track's last segment ended; a new one never starts before it.
    covered_until: u64,
    /// With no segment open, a healthy loopback track is padded from here.
    cover_from: Option<u64>,
    taps: Vec<SyncSender<Vec<u8>>>,
}

enum State {
    Open(Box<Live>),
    Lost { error: String, next_try: Instant },
}

struct Live {
    _capture: Box<dyn Capture>,
    device: DeviceInfo,
    resampler: Resampler,
    flags: Arc<StreamFlags>,
    last_packet: Instant,
}

struct Segment {
    writer: SegmentWriter,
    seq: u64,
    t: u64,
}

impl Track {
    /// Where the track's audio ends, in samples since meeting time 0.
    fn covered_end(&self) -> Option<u64> {
        match (&self.segment, self.cover_from) {
            (Some(s), _) => {
                Some(s.t * SAMPLES_PER_MS + s.writer.samples() + self.pending.len() as u64)
            }
            (None, Some(from)) => Some(from * SAMPLES_PER_MS),
            (None, None) => None,
        }
    }

    /// Sends converted audio to every tap. A tap that can't keep up is disconnected: dropping
    /// blocks would hand dictation broken audio without a sign.
    fn send_taps(&mut self, pcm: &[i16]) {
        if self.taps.is_empty() {
            return;
        }
        let mut bytes = Vec::with_capacity(pcm.len() * 2);
        for sample in pcm {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        self.taps.retain(|tap| tap.try_send(bytes.clone()).is_ok());
    }
}

struct Stopping {
    reason: String,
    reply: Option<Sender<Reply>>,
}

struct Schedule {
    tick: Instant,
    heartbeat: Instant,
    poll: Instant,
    sync: Instant,
}

/// The next time of a periodic task; a schedule that fell behind restarts from now.
fn later(previous: Instant, period: Duration, now: Instant) -> Instant {
    let next = previous + period;
    if next <= now {
        now + period
    } else {
        next
    }
}

struct Recorder {
    dir: PathBuf,
    journal: Journal,
    clock: MeetingClock,
    backend: Backend,
    events: SyncSender<Event>,
    tracks: Vec<Track>,
    paused: bool,
    last_mark: u64,
    limit_ms: u64,
    segment_samples: u64,
    /// Meeting time and wall time of the last heartbeat.
    heartbeat: (u64, u64),
    stop: Option<Stopping>,
}

impl Recorder {
    fn run(&mut self, rx: Receiver<Event>) {
        let now = Instant::now();
        let mut schedule = Schedule {
            tick: now + TICK,
            heartbeat: now + HEARTBEAT,
            poll: now + DEFAULT_POLL,
            sync: now + SYNC,
        };
        while self.stop.is_none() {
            let wait = schedule.tick.saturating_duration_since(Instant::now());
            match rx.recv_timeout(wait) {
                Ok(event) => {
                    self.handle(event);
                    // Catch up on everything queued before the timers run, so audio that piled
                    // up during a stall is written before a suspend check closes the segments.
                    for event in rx.try_iter().take(EVENT_QUEUE) {
                        if self.stop.is_some() {
                            break;
                        }
                        self.handle(event);
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
            let now = Instant::now();
            if self.stop.is_none() && now >= schedule.tick {
                self.tick(now, &mut schedule);
            }
        }
        self.finish();
    }

    fn handle(&mut self, event: Event) {
        match event {
            Event::Audio {
                track,
                generation,
                at,
                data,
            } => self.on_audio(track, generation, at, &data),
            Event::Failed { track, generation } => {
                if self.tracks[track].generation == generation {
                    self.check_failure(track);
                }
            }
            Event::Command { command, reply, at } => self.on_command(command, reply, at),
        }
    }

    fn tick(&mut self, now: Instant, schedule: &mut Schedule) {
        schedule.tick = now + TICK;
        let wall = wall_ms();
        if let Some(jump) = clock::suspend_jump(self.heartbeat.1, wall) {
            self.suspend(jump, wall);
            schedule.heartbeat = now + HEARTBEAT;
        }
        for i in 0..self.tracks.len() {
            self.check_failure(i);
            self.check_stall(i, now);
            self.retry(i, now);
            self.pad(i, PAD_THRESHOLD_MS);
            self.flush_pending(i);
        }
        if now >= schedule.heartbeat {
            schedule.heartbeat = later(schedule.heartbeat, HEARTBEAT, now);
            self.write_heartbeat(wall);
        }
        if now >= schedule.poll {
            schedule.poll = now + DEFAULT_POLL;
            for i in 0..self.tracks.len() {
                self.follow_default(i);
            }
        }
        if now >= schedule.sync {
            schedule.sync = now + SYNC;
            self.sync();
        }
        if self.clock.now() >= self.limit_ms {
            self.stop = Some(Stopping {
                reason: "limit".into(),
                reply: None,
            });
        }
    }

    fn on_audio(&mut self, i: usize, generation: u64, at: Instant, data: &[f32]) {
        let paused = self.paused;
        let arrived = self.clock.at(at);
        let track = &mut self.tracks[i];
        if track.generation != generation {
            return;
        }
        let State::Open(live) = &mut track.state else {
            return;
        };
        live.last_packet = Instant::now();
        let overrun = live.flags.overrun.swap(false, Ordering::Relaxed);
        if overrun && !paused && track.segment.is_some() {
            // Blocks were dropped before this one: end the segment first, so the gap shows
            // between segments instead of hiding inside one.
            log(format_args!(
                "{}: the recorder fell behind; audio was lost",
                track.name
            ));
            self.close_segment(i, false);
            self.tracks[i].cover_from = Some(self.clock.now());
        }
        let track = &mut self.tracks[i];
        let State::Open(live) = &mut track.state else {
            return;
        };
        let pcm = live.resampler.process(data);
        if pcm.is_empty() {
            return;
        }
        track.send_taps(&pcm);
        if paused {
            return;
        }
        if self.tracks[i].segment.is_none() {
            let estimate = arrived.saturating_sub(samples_to_ms(pcm.len() as u64));
            let start = estimate.max(self.tracks[i].covered_until);
            if !self.start_segment(i, start) {
                return;
            }
        }
        let track = &mut self.tracks[i];
        track.pending.extend_from_slice(&pcm);
        track.pending_end = arrived;
        if track.pending.len() >= APPEND_SAMPLES {
            self.flush_pending(i);
        }
    }

    /// Marks and dictation are moments the user pointed at, so they keep the time the request
    /// arrived even when this thread is busy. Pause, resume and stop take effect when they run,
    /// which keeps them in line with the segment boundaries.
    fn on_command(&mut self, command: Command, reply: Sender<Reply>, at: Instant) {
        let answer = match command {
            Command::Status => Reply::ok(self.status()),
            Command::Stop { reason } => {
                self.stop = Some(Stopping {
                    reason,
                    reply: Some(reply),
                });
                return;
            }
            Command::Pause if self.paused => Reply::error("not_recording"),
            Command::Pause => Reply::ok(json!({ "ok": true, "t": self.pause() })),
            Command::Resume if !self.paused => Reply::error("not_recording"),
            Command::Resume => Reply::ok(json!({ "ok": true, "t": self.resume() })),
            Command::Mark { label } => {
                self.last_mark += 1;
                let id = format!("k-{}", self.last_mark);
                let t = self.clock.at(at);
                self.journal.write(Line::Mark {
                    t,
                    id: id.clone(),
                    label,
                });
                Reply::ok(json!({ "ok": true, "id": id, "t": t }))
            }
            Command::Dictation { state } => {
                let t = self.clock.at(at);
                self.journal.write(Line::Dictation { t, state });
                Reply::ok(json!({ "ok": true, "t": t }))
            }
            Command::Tap { track, pcm } => match self.tracks.iter_mut().find(|t| t.name == track) {
                Some(track) => {
                    track.taps.push(pcm);
                    Reply::ok(json!({ "ok": true, "rate": SAMPLE_RATE }))
                }
                None => Reply::error("unknown_track"),
            },
        };
        let _ = reply.send(answer);
    }

    fn status(&self) -> Value {
        let tracks: serde_json::Map<String, Value> = self
            .tracks
            .iter()
            .map(|track| {
                let value = match &track.state {
                    State::Open(live) => json!({ "device": live.device.name, "ok": true }),
                    State::Lost { error, .. } => {
                        json!({ "device": null, "ok": false, "error": error })
                    }
                };
                (track.name.clone(), value)
            })
            .collect();
        json!({
            "ok": true,
            "state": if self.paused { "paused" } else { "recording" },
            "t": self.clock.now(),
            "tracks": tracks,
        })
    }

    fn pause(&mut self) -> u64 {
        for i in 0..self.tracks.len() {
            self.close_segment(i, true);
            self.tracks[i].cover_from = None;
        }
        self.paused = true;
        let t = self.clock.now();
        self.journal.write(Line::Pause { t });
        t
    }

    fn resume(&mut self) -> u64 {
        let t = self.clock.now();
        self.paused = false;
        for track in &mut self.tracks {
            track.cover_from = Some(t);
            track.covered_until = track.covered_until.max(t);
        }
        self.journal.write(Line::Resume { t });
        t
    }

    /// Opens the track's source and writes `track`, preceded by `device` when the track got
    /// its device back or moved to another one.
    fn try_open(&mut self, i: usize, after_loss: bool) -> Result<(), String> {
        let track = &mut self.tracks[i];
        track.generation += 1;
        let flags = Arc::new(StreamFlags::default());
        let sink = Sink::new(self.events.clone(), i, track.generation, flags.clone());
        let opened = self.backend.open(&track.spec, sink)?;
        let resampler = Resampler::new(opened.rate, opened.channels)
            .ok_or_else(|| "The device reports no sample rate or channels.".to_string())?;
        let t = self.clock.now();
        let moved = track
            .device_id
            .as_ref()
            .is_some_and(|id| *id != opened.device.id);
        let reason = match (after_loss, moved) {
            (_, true) => Some("default"),
            (true, false) => Some("reconnected"),
            (false, false) => None,
        };
        if let Some(reason) = reason {
            self.journal.write(Line::Device {
                t,
                track: track.name.clone(),
                device: opened.device.name.clone(),
                reason: reason.into(),
            });
        }
        self.journal.write(Line::Track {
            t,
            track: track.name.clone(),
            source: track.spec.to_string(),
            device: opened.device.name.clone(),
            device_id: opened.device.id.clone(),
            native_rate: opened.rate,
            native_channels: opened.channels,
        });
        track.device_id = Some(opened.device.id.clone());
        track.cover_from = (!self.paused).then_some(t);
        track.covered_until = track.covered_until.max(t);
        track.state = State::Open(Box::new(Live {
            _capture: opened.capture,
            device: opened.device,
            resampler,
            flags,
            last_packet: Instant::now(),
        }));
        Ok(())
    }

    /// Records that the track has no device and schedules the first retry.
    fn mark_lost(&mut self, i: usize, error: String) {
        let t = self.clock.now();
        let track = &mut self.tracks[i];
        track.state = State::Lost {
            error: error.clone(),
            next_try: Instant::now() + RETRY,
        };
        track.cover_from = None;
        self.journal.write(Line::DeviceLost {
            t,
            track: track.name.clone(),
            error,
        });
    }

    /// The device failed: end the segment, then drop the stream and retry every second.
    fn lose(&mut self, i: usize, error: String) {
        self.close_segment(i, false);
        self.mark_lost(i, error);
    }

    /// The stream must be rebuilt, usually on a new default device.
    fn rebuild(&mut self, i: usize, reason: String) {
        self.close_segment(i, false);
        // Drop the old stream before opening the new one.
        self.tracks[i].state = State::Lost {
            error: reason,
            next_try: Instant::now(),
        };
        if let Err(error) = self.try_open(i, false) {
            self.mark_lost(i, error);
        }
    }

    fn check_failure(&mut self, i: usize) {
        let State::Open(live) = &self.tracks[i].state else {
            return;
        };
        match live.flags.take_failure() {
            Some(Failure::Lost(error)) => self.lose(i, error),
            Some(Failure::Rebuild(reason)) => self.rebuild(i, reason),
            None => {}
        }
    }

    fn check_stall(&mut self, i: usize, now: Instant) {
        let track = &self.tracks[i];
        let State::Open(live) = &track.state else {
            return;
        };
        if !track.spec.is_loopback() && now.duration_since(live.last_packet) > STALL {
            self.lose(i, "The device stopped delivering audio.".into());
        }
    }

    fn retry(&mut self, i: usize, now: Instant) {
        let State::Lost { next_try, .. } = &self.tracks[i].state else {
            return;
        };
        let next_try = *next_try;
        if now < next_try {
            return;
        }
        if let Err(error) = self.try_open(i, true) {
            self.tracks[i].state = State::Lost {
                error,
                next_try: later(next_try, RETRY, now),
            };
        }
    }

    /// Moves a `default-*` track to the new default device.
    fn follow_default(&mut self, i: usize) {
        let track = &self.tracks[i];
        if !track.spec.follows_default() {
            return;
        }
        let State::Open(live) = &track.state else {
            return;
        };
        let Some(id) = self.backend.default_device_id(&track.spec) else {
            return;
        };
        if id != live.device.id {
            self.rebuild(i, "The default device changed.".into());
        }
    }

    /// The computer slept: end every segment, move the clock past the jump and reopen the
    /// devices, which rarely survive a sleep.
    fn suspend(&mut self, jump: u64, wall: u64) {
        let from = self.heartbeat.0;
        let mut was_lost = Vec::with_capacity(self.tracks.len());
        for i in 0..self.tracks.len() {
            self.close_segment(i, false);
            was_lost.push(matches!(self.tracks[i].state, State::Lost { .. }));
            self.tracks[i].state = State::Lost {
                error: "The computer was asleep.".into(),
                next_try: Instant::now(),
            };
        }
        self.clock.advance_to(from + jump);
        let until = self.clock.now();
        self.journal.write(Line::Suspend { t: from, until });
        self.heartbeat = (until, wall);
        for (i, lost) in was_lost.into_iter().enumerate() {
            if let Err(error) = self.try_open(i, lost) {
                self.mark_lost(i, error);
            }
        }
    }

    fn pad(&mut self, i: usize, threshold_ms: u64) {
        let now = self.clock.now();
        let track = &self.tracks[i];
        let Some(covered) = track.covered_end() else {
            return;
        };
        let healthy = matches!(track.state, State::Open(_));
        let needed = padding(
            track.spec.is_loopback(),
            healthy,
            self.paused,
            covered,
            now,
            threshold_ms,
        );
        if needed == 0 {
            return;
        }
        if track.segment.is_none() {
            let from = covered / SAMPLES_PER_MS;
            if !self.start_segment(i, from) {
                return;
            }
        }
        // At most one segment's worth per call; the next tick continues.
        let needed = needed.min(self.segment_samples) as usize;
        let track = &mut self.tracks[i];
        track.pending.resize(track.pending.len() + needed, 0);
        track.pending_end = now;
        self.flush_pending(i);
    }

    fn start_segment(&mut self, i: usize, t: u64) -> bool {
        loop {
            let track = &mut self.tracks[i];
            track.seq += 1;
            let seq = track.seq;
            let file = meeting::segment_file(&track.name, seq);
            match SegmentWriter::create(&self.dir.join(&file)) {
                Ok(writer) => {
                    track.segment = Some(Segment { writer, seq, t });
                    track.cover_from = None;
                    self.journal.write(Line::Segment {
                        t,
                        track: track.name.clone(),
                        seq,
                        file,
                    });
                    return true;
                }
                // A file left by a session that died before naming it; never overwrite it.
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => {
                    self.write_failed(i, &e);
                    return false;
                }
            }
        }
    }

    /// Appends pending audio, starting a new segment every 30 s.
    fn flush_pending(&mut self, i: usize) {
        let segment_samples = self.segment_samples;
        loop {
            let track = &mut self.tracks[i];
            let Some(segment) = track.segment.as_mut() else {
                track.pending.clear();
                return;
            };
            if track.pending.is_empty() && segment.writer.samples() < segment_samples {
                return;
            }
            let room = (segment_samples - segment.writer.samples()) as usize;
            let n = room.min(track.pending.len());
            if let Err(e) = segment.writer.append(&track.pending[..n]) {
                self.write_failed(i, &e);
                return;
            }
            track.pending.drain(..n);
            if segment.writer.samples() < segment_samples {
                return;
            }
            let contiguous = segment.t + samples_to_ms(segment_samples);
            let estimate = track
                .pending_end
                .saturating_sub(samples_to_ms(track.pending.len() as u64));
            let next = next_segment_start(contiguous, estimate);
            self.end_segment(i);
            if !self.start_segment(i, next) {
                return;
            }
        }
    }

    /// Closes the segment file and writes `segment_end`.
    fn end_segment(&mut self, i: usize) {
        let track = &mut self.tracks[i];
        let Some(segment) = track.segment.take() else {
            return;
        };
        let samples = segment.writer.samples();
        if let Err(e) = segment.writer.close() {
            log(format_args!(
                "{}: can't sync segment {}: {e}",
                track.name, segment.seq
            ));
        }
        let end = segment.t + samples_to_ms(samples);
        track.covered_until = track.covered_until.max(end);
        self.journal.write(Line::SegmentEnd {
            t: end,
            track: track.name.clone(),
            seq: segment.seq,
            samples,
        });
    }

    /// Writes what's pending and ends the segment. With `pad`, a healthy loopback track is
    /// first padded up to now.
    fn close_segment(&mut self, i: usize, pad: bool) {
        // The resampler holds back about a millisecond; it belongs to this segment.
        if let State::Open(live) = &mut self.tracks[i].state {
            let tail = live.resampler.flush();
            if self.tracks[i].segment.is_some() {
                self.tracks[i].pending.extend_from_slice(&tail);
            }
        }
        if pad {
            self.pad(i, 0);
        }
        self.flush_pending(i);
        self.end_segment(i);
        self.tracks[i].pending.clear();
    }

    /// The disk refused audio: end the segment with what it holds and treat the track like a
    /// lost device, so it retries every second and the gap is marked.
    fn write_failed(&mut self, i: usize, e: &io::Error) {
        self.tracks[i].pending.clear();
        self.end_segment(i);
        self.lose(i, format!("Writing the audio failed: {e}"));
    }

    fn write_heartbeat(&mut self, wall: u64) {
        let samples: BTreeMap<String, u64> = self
            .tracks
            .iter()
            .filter_map(|t| Some((t.name.clone(), t.segment.as_ref()?.writer.samples())))
            .collect();
        let t = self.clock.now();
        self.journal.write(Line::Heartbeat { t, wall, samples });
        self.heartbeat = (t, wall);
    }

    fn sync(&mut self) {
        for track in &self.tracks {
            if let Some(segment) = &track.segment {
                if let Err(e) = segment.writer.sync() {
                    log(format_args!("{}: can't sync: {e}", track.name));
                }
            }
        }
        self.journal.sync();
    }

    fn finish(&mut self) {
        let stopping = self.stop.take().unwrap_or(Stopping {
            reason: "interrupted".into(),
            reply: None,
        });
        for i in 0..self.tracks.len() {
            self.close_segment(i, true);
        }
        // The recording ends here; stopping the streams afterwards can take a while.
        let (t, wall) = (self.clock.now(), wall_ms());
        for track in &mut self.tracks {
            track.state = State::Lost {
                error: "Stopped.".into(),
                next_try: Instant::now(),
            };
            track.taps.clear();
        }
        self.journal.write(Line::Stop {
            t,
            wall,
            reason: stopping.reason,
        });
        self.journal.sync();
        meeting::remove_recorder_file(&self.dir);
        if let Some(reply) = stopping.reply {
            let (written, done) = mpsc::channel();
            let _ = reply.send(Reply {
                value: json!({ "ok": true, "t": t }),
                written: Some(written),
            });
            let _ = done.recv_timeout(Duration::from_secs(2));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pads_a_healthy_silent_loopback_track_past_the_threshold() {
        // 1 s of the call covered, the clock at 1.4 s: within the threshold, no padding yet.
        assert_eq!(padding(true, true, false, 16_000, 1_400, 500), 0);
        // At 1.6 s the track trails by 600 ms and is padded up to the clock.
        assert_eq!(padding(true, true, false, 16_000, 1_600, 500), 9_600);
        // On stop or pause the threshold is 0: any deficit is filled.
        assert_eq!(padding(true, true, false, 16_000, 1_001, 0), 16);
        assert_eq!(padding(true, true, false, 16_000, 1_000, 0), 0);
    }

    #[test]
    fn never_pads_a_microphone_a_failed_device_or_a_pause() {
        // A microphone always delivers; a gap in it is real loss and stays a gap.
        assert_eq!(padding(false, true, false, 0, 10_000, 500), 0);
        // Padding stops the moment the device reports an error.
        assert_eq!(padding(true, false, false, 0, 10_000, 500), 0);
        // A pause records nothing, not even silence.
        assert_eq!(padding(true, true, true, 0, 10_000, 500), 0);
    }

    #[test]
    fn a_track_running_ahead_is_never_trimmed() {
        assert_eq!(padding(true, true, false, 32_000, 1_000, 0), 0);
    }

    #[test]
    fn segments_stay_contiguous_unless_the_device_clock_drifted() {
        assert_eq!(next_segment_start(30_000, 30_000), 30_000);
        assert_eq!(next_segment_start(30_000, 30_060), 30_000);
        assert_eq!(next_segment_start(30_000, 29_950), 30_000);
        assert_eq!(next_segment_start(30_000, 30_150), 30_150);
        assert_eq!(next_segment_start(30_000, 29_850), 29_850);
    }

    #[test]
    fn late_schedules_restart_from_now() {
        let now = Instant::now();
        let period = Duration::from_secs(1);
        assert_eq!(later(now, period, now), now + period);
        let long_ago = now.checked_sub(Duration::from_secs(10));
        if let Some(long_ago) = long_ago {
            assert_eq!(later(long_ago, period, now), now + period);
        }
    }
}
