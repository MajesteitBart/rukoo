//! Follows a meeting's screen journal (`screen/journal.jsonl`, voice/RECORDING.md "The screen
//! folder") and turns it into the events Rukoo gets: a `frame` for each saved frame, and the
//! screen marks of voice/PROTOCOL.md.
//!
//! The screen process writes the journal; this only reads it, the way the pipeline reads the
//! recorder's timeline. Every event has a stable key, so reading the journal again from the start
//! after a restart sends nothing twice.
//!
//! | Journal | Event |
//! |---|---|
//! | `frame` | `frame { id, at, width, height, text }` |
//! | `dropped` video | mark `dropped-video`, kind `video_dropped` |
//! | `dropped` frames | mark `dropped-frames`, kind `dropped` |
//! | `monitor` with reason `user` or `lost` | mark `monitor-<t 9 digits>`, kind `monitor` |
//! | `lock` then `unlock` (or `stop`) | mark `gap-screen-<t>`, kind `screen_gap`, detail `locked` |
//! | `crash` | mark `gap-screen-<lastSeen>`, kind `screen_gap`, detail `crash` |
//! | `device_lost` then `capture` (or `stop`) | mark `gap-screen-<t>`, kind `screen_gap`, detail `device` |
//! | `stop` reason `failed`: the app gave up on the screen process | mark `dropped-frames`, kind `dropped`, detail `crash` |

use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use voice_protocol::{Frame, Mark, MarkKind, MarkTrack, MAX_FRAME_TEXT_CHARS};
use voice_screen_files::journal::{JournalReader, Line};
use voice_screen_files::screenfile;

/// How long after the timeline's `stop` a meeting waits for the screen journal's `stop` when no
/// screen process answers any more. A live one gets as long as it needs: it drains its OCR and
/// finalizes its video within seconds of the recorder's stop.
pub const SCREEN_STOP_WAIT: Duration = Duration::from_secs(60);
/// How often a waiting meeting asks whether the screen process still lives.
const LIVE_CHECK: Duration = Duration::from_secs(2);

/// An event the screen journal leads to.
#[derive(Clone, Debug, PartialEq)]
pub enum ScreenDerived {
    Frame(Frame),
    Mark(Mark),
}

/// The key the pipeline stores for an event once the log has it: `frame:<id>` or `mark:<id>`.
pub fn derived_key(d: &ScreenDerived) -> String {
    match d {
        ScreenDerived::Frame(frame) => format!("frame:{}", frame.id),
        ScreenDerived::Mark(mark) => format!("mark:{}", mark.id),
    }
}

/// The `stop` line of the screen journal.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Stopped {
    t: u64,
    reason: String,
}

/// Reads a meeting's screen journal as it grows.
#[derive(Debug)]
pub struct ScreenFollower {
    meeting: PathBuf,
    reader: JournalReader,
    /// The `t` of a `lock` without its `unlock` yet.
    locked: Option<u64>,
    /// The `t` of a `device_lost` without the `capture` that ends it yet.
    device_lost: Option<u64>,
    /// The highest `t` of any line, and whether any line came at all.
    last_t: u64,
    seen_lines: bool,
    stopped: Option<Stopped>,
    finished: bool,
    /// How long to wait for the journal's `stop` after the timeline's, without a live process.
    wait: Duration,
    stop_seen: Option<Instant>,
    live_checked: Option<(Instant, bool)>,
}

impl ScreenFollower {
    pub fn new(meeting: &Path) -> ScreenFollower {
        ScreenFollower::with_wait(meeting, SCREEN_STOP_WAIT)
    }

    /// A follower that waits `wait` instead of [`SCREEN_STOP_WAIT`], for tests.
    pub fn with_wait(meeting: &Path, wait: Duration) -> ScreenFollower {
        ScreenFollower {
            meeting: meeting.to_path_buf(),
            reader: JournalReader::new(meeting),
            locked: None,
            device_lost: None,
            last_t: 0,
            seen_lines: false,
            stopped: None,
            finished: false,
            wait,
            stop_seen: None,
            live_checked: None,
        }
    }

    /// The events of the journal's lines since the last poll. A journal that doesn't exist yet
    /// has no lines.
    pub fn poll(&mut self) -> io::Result<Vec<ScreenDerived>> {
        let lines = match self.reader.poll() {
            Ok(lines) => lines,
            Err(e) if e.kind() == io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e),
        };
        let mut out = Vec::new();
        for line in &lines {
            self.feed(line, &mut out);
        }
        Ok(out)
    }

    fn feed(&mut self, line: &Line, out: &mut Vec<ScreenDerived>) {
        if self.stopped.is_some() {
            // Nothing follows `stop`.
            return;
        }
        if let Some(t) = line.t() {
            self.last_t = self.last_t.max(t);
            self.seen_lines = true;
        }
        match line {
            Line::Frame {
                t,
                id,
                width,
                height,
                text,
                ..
            } => out.push(ScreenDerived::Frame(Frame {
                id: id.clone(),
                at: *t,
                width: *width,
                height: *height,
                text: cut(text),
            })),
            Line::Dropped { t, what, reason } => {
                let (id, kind) = match what.as_str() {
                    "video" => ("dropped-video", MarkKind::Other("video_dropped".into())),
                    "frames" => ("dropped-frames", MarkKind::Dropped),
                    _ => return,
                };
                out.push(ScreenDerived::Mark(mark(
                    id.into(),
                    kind,
                    *t,
                    None,
                    Some(reason.clone()),
                    None,
                )));
            }
            Line::Monitor {
                t, name, reason, ..
            } if reason == "user" || reason == "lost" => {
                out.push(ScreenDerived::Mark(mark(
                    format!("monitor-{t:09}"),
                    MarkKind::Other("monitor".into()),
                    *t,
                    None,
                    Some(reason.clone()),
                    Some(name.clone()),
                )));
            }
            Line::Lock { t } => {
                self.locked.get_or_insert(*t);
            }
            Line::Unlock { t } => {
                if let Some(at) = self.locked.take() {
                    out.push(ScreenDerived::Mark(gap(at, *t, "locked")));
                }
            }
            Line::DeviceLost { t } => {
                self.device_lost.get_or_insert(*t);
            }
            Line::Capture { t, .. } => {
                if let Some(at) = self.device_lost.take() {
                    out.push(ScreenDerived::Mark(gap(at, *t, "device")));
                }
            }
            Line::Crash { t, last_seen } => {
                // The dead session's open gaps end where it was last seen; the resumed session
                // writes `lock` again when the computer is still locked.
                self.close_open(*last_seen, out);
                out.push(ScreenDerived::Mark(gap(*last_seen, *t, "crash")));
            }
            Line::Stop { t, reason } => {
                self.close_open(*t, out);
                // The app writes `failed` when it gave up restarting the screen process while
                // the meeting records: the screen recording stopped for good, now.
                if reason == "failed" {
                    out.push(ScreenDerived::Mark(mark(
                        "dropped-frames".into(),
                        MarkKind::Dropped,
                        *t,
                        None,
                        Some("crash".into()),
                        None,
                    )));
                }
                self.stopped = Some(Stopped {
                    t: *t,
                    reason: reason.clone(),
                });
            }
            _ => {}
        }
    }

    /// Ends an open lock gap and an open device gap at `until`. A gap that would end where it
    /// starts says nothing and is left out.
    fn close_open(&mut self, until: u64, out: &mut Vec<ScreenDerived>) {
        if let Some(at) = self.locked.take().filter(|at| *at < until) {
            out.push(ScreenDerived::Mark(gap(at, until, "locked")));
        }
        if let Some(at) = self.device_lost.take().filter(|at| *at < until) {
            out.push(ScreenDerived::Mark(gap(at, until, "device")));
        }
    }

    /// The screen part of the meeting is over: the timeline stopped at `timeline_stop_t`. Closes
    /// a lock or device gap still open, and covers the screen's silence after a screen process
    /// that vanished without a `stop`. One the app gave up on has its `dropped` mark already.
    /// Returns those marks once; later calls return nothing.
    pub fn finish(&mut self, timeline_stop_t: u64) -> Vec<ScreenDerived> {
        if self.finished {
            return Vec::new();
        }
        self.finished = true;
        let mut out = Vec::new();
        match self.stopped {
            Some(_) => {}
            None => {
                // A lock or device gap still open explains the silence to the end; otherwise the
                // screen process vanished after its last line.
                self.close_open(timeline_stop_t.max(self.last_t), &mut out);
                if out.is_empty() && self.seen_lines && self.last_t < timeline_stop_t {
                    out.push(ScreenDerived::Mark(gap(
                        self.last_t,
                        timeline_stop_t,
                        "crash",
                    )));
                }
            }
        }
        out
    }

    /// Whether the journal has its `stop` line.
    pub fn stopped(&self) -> bool {
        self.stopped.is_some()
    }

    /// For the pipeline at the timeline's `stop`: `Some` with the closing marks once the screen
    /// is settled, which is when the journal has `stop`, or [`SCREEN_STOP_WAIT`] after the
    /// timeline's stop was first seen while no screen process answers. `None` while it waits.
    /// Call [`ScreenFollower::poll`] first; this reads nothing new.
    pub fn settle(&mut self, timeline_stop_t: u64) -> Option<Vec<ScreenDerived>> {
        if self.finished || self.stopped.is_some() {
            return Some(self.finish(timeline_stop_t));
        }
        let now = Instant::now();
        let since = *self.stop_seen.get_or_insert(now);
        if now.duration_since(since) < self.wait {
            return None;
        }
        let live = match self.live_checked {
            Some((at, live)) if now.duration_since(at) < LIVE_CHECK => live,
            _ => {
                let live = screenfile::live(&self.meeting).is_some();
                self.live_checked = Some((now, live));
                live
            }
        };
        if live {
            return None;
        }
        Some(self.finish(timeline_stop_t))
    }
}

/// Frame text as Rukoo takes it: at most [`MAX_FRAME_TEXT_CHARS`] characters.
fn cut(text: &str) -> String {
    match text.char_indices().nth(MAX_FRAME_TEXT_CHARS) {
        Some((at, _)) => text[..at].to_owned(),
        None => text.to_owned(),
    }
}

fn mark(
    id: String,
    kind: MarkKind,
    at: u64,
    until: Option<u64>,
    detail: Option<String>,
    label: Option<String>,
) -> Mark {
    Mark {
        id,
        kind,
        at,
        until,
        track: Some(MarkTrack::Screen),
        detail,
        label,
    }
}

/// A `screen_gap` mark: the screen has no frames from `at` to `until`.
fn gap(at: u64, until: u64, detail: &str) -> Mark {
    mark(
        format!("gap-screen-{at}"),
        MarkKind::Other("screen_gap".into()),
        at,
        Some(until.max(at)),
        Some(detail.to_owned()),
        None,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    use serde_json::{json, Value};
    use std::fs::{self, OpenOptions};
    use std::io::Write;

    fn write(meeting: &Path, lines: &[Value]) {
        let path = voice_screen_files::paths::journal_path(meeting);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        for line in lines {
            file.write_all(format!("{line}\n").as_bytes()).unwrap();
        }
    }

    fn marks(derived: &[ScreenDerived]) -> Vec<&Mark> {
        derived
            .iter()
            .filter_map(|d| match d {
                ScreenDerived::Mark(m) => Some(m),
                ScreenDerived::Frame(_) => None,
            })
            .collect()
    }

    fn frame(t: u64, text: &str) -> Value {
        json!({"kind":"frame","t":t,"id":format!("f-{t:09}"),"file":format!("screen/frames/f-{t:09}.jpg"),"width":1920,"height":1080,"text":text,"ocr":"ok","language":"en-US"})
    }

    #[test]
    fn frames_and_marks_come_from_the_journal() {
        let tmp = TempDir::new("screen-follow");
        let meeting = tmp.path();
        let mut follower = ScreenFollower::new(meeting);
        assert!(
            follower.poll().unwrap().is_empty(),
            "no journal yet is no lines"
        );
        write(
            meeting,
            &[
                json!({"kind":"session","t":40,"wall":1,"boot":5,"session":1,"pid":7,"resumed":false,"version":1,"mode":"video","anchor":"boot","screen":"0.1.0"}),
                json!({"kind":"monitor","t":40,"id":"\\\\.\\DISPLAY1","name":"DELL","width":1920,"height":1080,"primary":true,"reason":"start"}),
                json!({"kind":"capture","t":60,"wall":2,"monitor":"\\\\.\\DISPLAY1","width":1920,"height":1080}),
                frame(60, "Slide 1"),
                json!({"kind":"dropped","t":900,"what":"video","reason":"encoder"}),
                json!({"kind":"monitor","t":5000,"id":"\\\\.\\DISPLAY2","name":"Display 2","width":1440,"height":2560,"primary":false,"reason":"user"}),
                json!({"kind":"lock","t":7000}),
                json!({"kind":"unlock","t":9000}),
                json!({"kind":"device_lost","t":10000}),
                json!({"kind":"capture","t":10500,"wall":3,"monitor":"\\\\.\\DISPLAY2","width":1440,"height":2560}),
                json!({"kind":"future_kind","t":11000}),
            ],
        );
        // A torn last line waits for its newline.
        let path = voice_screen_files::paths::journal_path(meeting);
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"{\"kind\":\"frame\",\"t\":12").unwrap();
        drop(file);

        let derived = follower.poll().unwrap();
        let frames: Vec<&Frame> = derived
            .iter()
            .filter_map(|d| match d {
                ScreenDerived::Frame(f) => Some(f),
                ScreenDerived::Mark(_) => None,
            })
            .collect();
        assert_eq!(frames.len(), 1);
        assert_eq!(
            (frames[0].id.as_str(), frames[0].at, frames[0].text.as_str()),
            ("f-000000060", 60, "Slide 1")
        );
        let found = marks(&derived);
        type Row = (String, String, u64, Option<u64>, Option<String>);
        let summary: Vec<Row> = found
            .iter()
            .map(|m| {
                (
                    m.id.clone(),
                    m.kind.as_str().to_owned(),
                    m.at,
                    m.until,
                    m.detail.clone(),
                )
            })
            .collect();
        assert_eq!(
            summary,
            vec![
                (
                    "dropped-video".into(),
                    "video_dropped".into(),
                    900,
                    None,
                    Some("encoder".into())
                ),
                (
                    "monitor-000005000".into(),
                    "monitor".into(),
                    5000,
                    None,
                    Some("user".into())
                ),
                (
                    "gap-screen-7000".into(),
                    "screen_gap".into(),
                    7000,
                    Some(9000),
                    Some("locked".into())
                ),
                (
                    "gap-screen-10000".into(),
                    "screen_gap".into(),
                    10000,
                    Some(10500),
                    Some("device".into())
                ),
            ]
        );
        assert!(found.iter().all(|m| m.track == Some(MarkTrack::Screen)));
        assert_eq!(found[1].label.as_deref(), Some("Display 2"));
        assert_eq!(
            derived_key(&ScreenDerived::Frame(frames[0].clone())),
            "frame:f-000000060"
        );
        assert_eq!(
            derived_key(&ScreenDerived::Mark(found[0].clone())),
            "mark:dropped-video"
        );

        // The rest of the torn line, a dropped-frames line and the stop.
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"500,\"id\":\"f-000012500\",\"file\":\"screen/frames/f-000012500.jpg\",\"width\":1440,\"height\":2560,\"text\":\"\",\"ocr\":\"none\",\"language\":null}\n").unwrap();
        drop(file);
        write(
            meeting,
            &[
                json!({"kind":"dropped","t":13000,"what":"frames","reason":"disk"}),
                json!({"kind":"stop","t":13000,"reason":"dropped"}),
                frame(14000, "after the stop"),
            ],
        );
        let derived = follower.poll().unwrap();
        assert!(follower.stopped());
        assert_eq!(derived.len(), 2, "{derived:?}");
        assert!(matches!(&derived[0], ScreenDerived::Frame(f) if f.id == "f-000012500"));
        let m = &marks(&derived)[0];
        assert_eq!(
            (m.id.as_str(), m.kind.clone(), m.detail.as_deref()),
            ("dropped-frames", MarkKind::Dropped, Some("disk"))
        );
        assert_eq!(
            follower.finish(20000),
            Vec::new(),
            "a dropped stop is no gap"
        );
    }

    #[test]
    fn open_gaps_close_at_the_stop_and_a_crash_is_a_gap() {
        let tmp = TempDir::new("screen-gaps");
        let meeting = tmp.path();
        write(
            meeting,
            &[
                json!({"kind":"lock","t":1000}),
                json!({"kind":"heartbeat","t":3000,"wall":1,"frames":0,"videoBytes":0}),
                json!({"kind":"crash","t":6000,"lastSeen":3000}),
                json!({"kind":"lock","t":6000}),
                json!({"kind":"device_lost","t":6500}),
                json!({"kind":"stop","t":8000,"reason":"meeting"}),
            ],
        );
        let mut follower = ScreenFollower::new(meeting);
        let derived = follower.poll().unwrap();
        let ids: Vec<(String, u64, Option<u64>, String)> = marks(&derived)
            .iter()
            .map(|m| {
                (
                    m.id.clone(),
                    m.at,
                    m.until,
                    m.detail.clone().unwrap_or_default(),
                )
            })
            .collect();
        assert_eq!(
            ids,
            vec![
                ("gap-screen-1000".into(), 1000, Some(3000), "locked".into()),
                ("gap-screen-3000".into(), 3000, Some(6000), "crash".into()),
                ("gap-screen-6000".into(), 6000, Some(8000), "locked".into()),
                ("gap-screen-6500".into(), 6500, Some(8000), "device".into()),
            ]
        );

        // Read again from the start, as a restarted pipeline does: the same marks, the same ids.
        let mut again = ScreenFollower::new(meeting);
        assert_eq!(again.poll().unwrap(), derived);
    }

    #[test]
    fn finish_covers_a_screen_that_gave_up_or_vanished() {
        let tmp = TempDir::new("screen-finish");
        let failed = tmp.path().join("failed");
        write(
            &failed,
            &[
                frame(500, "one"),
                json!({"kind":"stop","t":4000,"reason":"failed"}),
            ],
        );
        let mut follower = ScreenFollower::new(&failed);
        // A screen process the app gave up on: a `dropped` mark at once, while the meeting
        // records, and no gap that says the recorder restarted when the meeting ends.
        let read = follower.poll().unwrap();
        let m = marks(&read);
        assert_eq!(m.len(), 1, "{m:?}");
        assert_eq!(
            (
                m[0].id.as_str(),
                &m[0].kind,
                m[0].at,
                m[0].until,
                m[0].detail.as_deref()
            ),
            (
                "dropped-frames",
                &MarkKind::Dropped,
                4000,
                None,
                Some("crash")
            )
        );
        assert!(
            follower.finish(9000).is_empty(),
            "{:?}",
            follower.finish(9000)
        );

        // A journal that ends without stop while locked: the lock closes at the timeline's stop.
        let locked = tmp.path().join("locked");
        write(
            &locked,
            &[frame(500, "one"), json!({"kind":"lock","t":2000})],
        );
        let mut follower = ScreenFollower::new(&locked);
        follower.poll().unwrap();
        let closing = follower.finish(9000);
        let m = marks(&closing);
        assert_eq!(m.len(), 1, "{m:?}");
        assert_eq!((m[0].at, m[0].until), (2000, Some(9000)));
        assert_eq!(m[0].detail.as_deref(), Some("locked"));

        // One that ends without stop otherwise: the silence after its last line is a gap.
        let vanished = tmp.path().join("vanished");
        write(&vanished, &[frame(500, "one")]);
        let mut follower = ScreenFollower::new(&vanished);
        follower.poll().unwrap();
        let m = follower.finish(9000);
        assert_eq!(marks(&m)[0].id, "gap-screen-500");
        assert_eq!(marks(&m)[0].detail.as_deref(), Some("crash"));

        // No journal at all: nothing to say.
        let mut none = ScreenFollower::new(&tmp.path().join("none"));
        none.poll().unwrap();
        assert!(none.finish(9000).is_empty());
    }

    #[test]
    fn settle_waits_for_the_stop_or_the_wait_without_a_process() {
        let tmp = TempDir::new("screen-settle");
        let meeting = tmp.path();
        write(meeting, &[frame(500, "one")]);
        let mut follower = ScreenFollower::with_wait(meeting, Duration::from_millis(150));
        follower.poll().unwrap();
        assert_eq!(follower.settle(3000), None, "the wait starts now");
        std::thread::sleep(Duration::from_millis(200));
        // No screen.json, so no screen process answers: settled, with the silence as a gap.
        let closing = follower.settle(3000).expect("settled after the wait");
        assert_eq!(marks(&closing)[0].id, "gap-screen-500");
        assert_eq!(follower.settle(3000), Some(Vec::new()));

        let stopped = tmp.path().join("stopped");
        write(
            &stopped,
            &[json!({"kind":"stop","t":3000,"reason":"meeting"})],
        );
        let mut follower = ScreenFollower::new(&stopped);
        assert_eq!(follower.settle(3000), None, "nothing read yet");
        follower.poll().unwrap();
        assert_eq!(follower.settle(3000), Some(Vec::new()));
    }

    #[test]
    fn frame_text_is_cut_to_the_protocol_limit() {
        let long: String = "ü".repeat(MAX_FRAME_TEXT_CHARS + 10);
        let cut = cut(&long);
        assert_eq!(cut.chars().count(), MAX_FRAME_TEXT_CHARS);
        assert_eq!(super::cut("short"), "short");
    }
}

/// The pipeline with a screen journal: frames and screen marks reach the log while the meeting
/// records, `done` waits for the screen's `stop`, and a meeting whose transcription gives up
/// still sends its last frames before `failed`.
#[cfg(test)]
mod pipeline_tests {
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::path::Path;
    use std::sync::Arc;
    use std::thread;
    use std::time::{Duration, Instant};

    use serde_json::{json, Value};
    use voice_audio::SegmentWriter;
    use voice_bridge::{EventLog, Stored};
    use voice_core::{Hints, ProviderError, Recognized, SpeechToText};
    use voice_protocol::{ScreenMode, StartedBy, Track};

    use crate::library::{CreateMeeting, Library, MeetingDir};
    use crate::pipeline::{Pipeline, PipelineOptions, PipelineState, Timing};
    use crate::test_support::TempDir;

    struct Words;

    impl SpeechToText for Words {
        fn transcribe(&self, _pcm: &[i16], _hints: &Hints) -> Result<Recognized, ProviderError> {
            Ok(Recognized {
                text: "words".into(),
                language: None,
            })
        }
    }

    struct Offline;

    impl SpeechToText for Offline {
        fn transcribe(&self, _pcm: &[i16], _hints: &Hints) -> Result<Recognized, ProviderError> {
            Err(ProviderError::new(
                voice_core::ErrorKind::Network,
                "Network error.",
            ))
        }
    }

    fn options(stt: Arc<dyn SpeechToText>) -> PipelineOptions {
        PipelineOptions {
            timing: Timing {
                poll: Duration::from_millis(10),
                busy_poll: Duration::from_millis(1),
                retry_first: Duration::from_millis(10),
                retry_max: Duration::from_millis(40),
                attempts_after_stop: 2,
            },
            ..PipelineOptions::new(stt)
        }
    }

    fn meeting(lib: &Library) -> MeetingDir {
        lib.create(&CreateMeeting {
            title: "Screen".into(),
            tracks: vec![Track::Mic],
            sources: Default::default(),
            screen: ScreenMode::Frames,
            started_by: StartedBy::Voice,
            context: None,
        })
        .unwrap()
    }

    fn append(path: &Path, lines: &[Value]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        for line in lines {
            file.write_all(format!("{line}\n").as_bytes()).unwrap();
        }
    }

    fn timeline(dir: &MeetingDir, lines: &[Value]) {
        append(&dir.path().join("timeline.jsonl"), lines);
    }

    fn journal(dir: &MeetingDir, lines: &[Value]) {
        append(&voice_screen_files::paths::journal_path(dir.path()), lines);
    }

    /// The microphone records from 0 for `pcm`, and the meeting stops at `stop`.
    fn recorded(dir: &MeetingDir, pcm: &[i16], stop: u64) {
        timeline(
            dir,
            &[
                json!({"kind":"session","t":0,"wall":1_793_000_000_000u64,"session":1,"pid":1,"resumed":false,"version":1}),
            ],
        );
        let file = "audio/mic/000001.wav";
        let path = dir.path().join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut writer = SegmentWriter::create(&path).unwrap();
        timeline(
            dir,
            &[json!({"kind":"segment","t":0,"track":"mic","seq":1,"file":file})],
        );
        writer.append(pcm).unwrap();
        let samples = writer.close().unwrap();
        timeline(
            dir,
            &[
                json!({"kind":"segment_end","t":samples / 16,"track":"mic","seq":1,"samples":samples}),
                json!({"kind":"stop","t":stop,"wall":1_793_000_000_000u64 + stop,"reason":"user"}),
            ],
        );
    }

    fn frame(t: u64, text: &str) -> Value {
        json!({"kind":"frame","t":t,"id":format!("f-{t:09}"),"file":format!("screen/frames/f-{t:09}.jpg"),"width":1920,"height":1080,"text":text,"ocr":"ok","language":null})
    }

    fn events(log: &EventLog, id: &str) -> Vec<Stored> {
        log.meeting_events(id).unwrap().1
    }

    fn seq_of(events: &[Stored], what: impl Fn(&Stored) -> bool) -> Option<u64> {
        events.iter().find(|e| what(e)).map(|e| e.seq)
    }

    fn wait_until(what: &str, mut check: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(30);
        while !check() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn mark_ids(events: &[Stored]) -> Vec<String> {
        events
            .iter()
            .filter(|e| e.event == "mark")
            .map(|e| e.data["id"].as_str().unwrap().to_owned())
            .collect()
    }

    #[test]
    fn done_waits_for_the_screen_and_its_events_go_out_once() {
        let tmp = TempDir::new("pipeline-screen");
        let lib = Library::open(tmp.path()).unwrap();
        let log = EventLog::open(tmp.path()).unwrap();
        let dir = meeting(&lib);
        let id = dir.id().to_string();
        recorded(&dir, &vec![0i16; 16_000 * 2], 2000);
        journal(
            &dir,
            &[
                json!({"kind":"session","t":40,"wall":1,"session":1,"pid":7,"resumed":false,"version":1,"mode":"frames","anchor":"boot","screen":"0.1.0"}),
                frame(500, "Slide 1"),
                json!({"kind":"lock","t":1000}),
                json!({"kind":"unlock","t":1500}),
                json!({"kind":"device_lost","t":1600}),
                json!({"kind":"capture","t":1700,"wall":2,"monitor":"\\\\.\\DISPLAY1","width":1920,"height":1080}),
                json!({"kind":"monitor","t":1800,"id":"\\\\.\\DISPLAY2","name":"Display 2","width":1440,"height":2560,"primary":false,"reason":"user"}),
                json!({"kind":"lock","t":1950}),
            ],
        );
        let pipeline = Pipeline::start(dir.clone(), log.clone(), options(Arc::new(Words)));
        wait_until("the frame", || {
            events(&log, &id).iter().any(|e| e.event == "frame")
        });
        // The audio is transcribed, but the screen journal has no stop yet.
        thread::sleep(Duration::from_millis(400));
        assert!(
            !pipeline.state().is_final(),
            "done waits for the screen: {:?}",
            pipeline.state()
        );
        journal(
            &dir,
            &[
                frame(1990, "Slide 2"),
                json!({"kind":"stop","t":2000,"reason":"meeting"}),
            ],
        );
        wait_until("done", || pipeline.state() == PipelineState::Done);
        pipeline.shutdown();

        let all = events(&log, &id);
        let frames: Vec<(&str, u64, &str)> = all
            .iter()
            .filter(|e| e.event == "frame")
            .map(|e| {
                (
                    e.data["id"].as_str().unwrap(),
                    e.data["at"].as_u64().unwrap(),
                    e.data["text"].as_str().unwrap(),
                )
            })
            .collect();
        assert_eq!(
            frames,
            [
                ("f-000000500", 500, "Slide 1"),
                ("f-000001990", 1990, "Slide 2")
            ]
        );
        let ids = mark_ids(&all);
        for want in [
            "gap-screen-1000",
            "gap-screen-1600",
            "monitor-000001800",
            "gap-screen-1950",
        ] {
            assert!(ids.contains(&want.to_owned()), "{want} in {ids:?}");
        }
        let lock_at_stop = all
            .iter()
            .find(|e| e.event == "mark" && e.data["id"] == "gap-screen-1950")
            .unwrap();
        assert_eq!(
            lock_at_stop.data["until"], 2000,
            "the lock closes at the stop"
        );
        assert_eq!(lock_at_stop.data["track"], "screen");
        let done = seq_of(&all, |e| {
            e.event == "meeting.state" && e.data["state"] == "done"
        })
        .unwrap();
        let last_screen = seq_of(&all, |e| e.event == "frame" && e.data["at"] == 1990).unwrap();
        assert!(last_screen < done, "the last frame comes before done");

        // A pipeline over the same meeting again, as after a restart: nothing is sent twice.
        let again = Pipeline::start(dir.clone(), log.clone(), options(Arc::new(Words)));
        wait_until("done again", || again.state() == PipelineState::Done);
        again.shutdown();
        let after = events(&log, &id);
        assert_eq!(after.len(), all.len(), "no repeats after a restart");
        // The marks are in transcript.db too, like the recorder's.
        let stored = crate::transcript::Transcript::open(dir.path()).unwrap();
        let saved: Vec<String> = stored.marks().unwrap().into_iter().map(|m| m.id).collect();
        assert!(saved.contains(&"gap-screen-1000".to_owned()), "{saved:?}");
    }

    #[test]
    fn failed_meeting_still_sends_its_last_frames() {
        let tmp = TempDir::new("pipeline-screen-failed");
        let lib = Library::open(tmp.path()).unwrap();
        let log = EventLog::open(tmp.path()).unwrap();
        let dir = meeting(&lib);
        let id = dir.id().to_string();
        // Loud audio, so recognition runs and fails.
        let loud: Vec<i16> = (0..16_000 * 2)
            .map(|i| if (i / 27) % 2 == 0 { 4000 } else { -4000 })
            .collect();
        journal(
            &dir,
            &[frame(500, "Slide 1"), json!({"kind":"lock","t":1500})],
        );
        recorded(&dir, &loud, 2000);
        let pipeline = Pipeline::start(dir.clone(), log.clone(), options(Arc::new(Offline)));
        wait_until("the first frame", || {
            events(&log, &id).iter().any(|e| e.event == "frame")
        });
        // The recognizer gives up after the stop, but the screen still drains its OCR.
        thread::sleep(Duration::from_secs(3));
        assert!(
            !events(&log, &id)
                .iter()
                .any(|e| e.event == "meeting.state" && e.data["state"] == "failed"),
            "failed waits for the screen"
        );
        journal(
            &dir,
            &[
                frame(1200, "Slide 2"),
                frame(1400, "Slide 3"),
                json!({"kind":"stop","t":2000,"reason":"meeting"}),
            ],
        );
        wait_until("failed", || {
            matches!(pipeline.state(), PipelineState::Failed { .. })
        });
        pipeline.shutdown();
        let all = events(&log, &id);
        let failed = seq_of(&all, |e| {
            e.event == "meeting.state" && e.data["state"] == "failed"
        })
        .unwrap();
        for at in [1200, 1400] {
            let seq = seq_of(&all, |e| e.event == "frame" && e.data["at"] == at)
                .unwrap_or_else(|| panic!("frame {at} was sent"));
            assert!(seq < failed, "frame {at} before failed");
        }
        let gap = seq_of(&all, |e| {
            e.event == "mark" && e.data["id"] == "gap-screen-1500"
        })
        .expect("the lock gap closed at the stop");
        assert!(gap < failed);
    }
}
