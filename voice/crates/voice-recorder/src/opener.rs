//! The opener: a thread per track that creates the track's next segment file ahead of time, so
//! starting a segment never waits for the disk.
//!
//! Creating a file can take hundreds of milliseconds on Windows while a virus scanner checks
//! every new file, for instance right after a build. On the recorder thread that held up the
//! heartbeats (#209). The recorder asks for segment `n + 1` as soon as segment `n` starts, and
//! takes the file when it starts the next segment, whatever the reason: a full segment, a new
//! device, a resume or a wake from sleep.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use voice_audio::SegmentWriter;

use crate::disk;
use crate::meeting;

/// A segment file created for a track, or why it couldn't be.
pub struct Prepared {
    pub seq: u64,
    /// Relative to the meeting folder, as the timeline names it.
    pub file: String,
    pub created: io::Result<SegmentWriter>,
    /// How long the create took.
    pub took: Duration,
}

/// Creates the file of segment `from` of `track`, or of the first number after it that no file
/// has: a session that died right after creating a file never named it, and it is never
/// overwritten.
pub fn create(dir: &Path, track: &str, from: u64) -> Prepared {
    let mut seq = from;
    loop {
        let file = meeting::segment_file(track, seq);
        let started = Instant::now();
        let created = disk::create_segment(&dir.join(&file));
        let took = started.elapsed();
        match created {
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => seq += 1,
            created => {
                return Prepared {
                    seq,
                    file,
                    created,
                    took,
                }
            }
        }
    }
}

pub struct Opener {
    jobs: Option<Sender<u64>>,
    ready: Receiver<Prepared>,
    thread: Option<JoinHandle<()>>,
    /// A file was asked for and not taken yet.
    asked: bool,
}

impl Opener {
    pub fn start(dir: PathBuf, track: String) -> io::Result<Self> {
        let (jobs, rx) = mpsc::channel::<u64>();
        let (done, ready) = mpsc::channel();
        let thread = std::thread::Builder::new()
            .name(format!("opener-{track}"))
            .spawn(move || {
                for from in rx {
                    if done.send(create(&dir, &track, from)).is_err() {
                        return;
                    }
                }
            })?;
        Ok(Self {
            jobs: Some(jobs),
            ready,
            thread: Some(thread),
            asked: false,
        })
    }

    /// Asks for the file of segment `from`, or the first free number after it. Only one file is
    /// asked for at a time.
    pub fn ask(&mut self, from: u64) {
        if self.asked {
            return;
        }
        self.asked = self
            .jobs
            .as_ref()
            .is_some_and(|jobs| jobs.send(from).is_ok());
    }

    /// The file asked for, waiting for it when the thread is still creating it. `None` when
    /// nothing was asked for or the thread is gone.
    pub fn take(&mut self) -> Option<Prepared> {
        if !std::mem::take(&mut self.asked) {
            return None;
        }
        self.ready.recv().ok()
    }

    /// Stops the thread and returns the file it created that was never taken.
    pub fn finish(&mut self) -> Option<Prepared> {
        drop(self.jobs.take());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        self.asked = false;
        self.ready.try_iter().last()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_meeting(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "voice-recorder-opener-{name}-{}-{}",
            std::process::id(),
            crate::clock::wall_ms()
        ));
        std::fs::create_dir_all(dir.join("audio").join("mic")).unwrap();
        dir
    }

    #[test]
    fn creates_the_next_free_number_ahead() {
        let dir = temp_meeting("next");
        // A file a dead session never named.
        std::fs::write(dir.join("audio/mic/000003.wav"), b"").unwrap();
        let mut opener = Opener::start(dir.clone(), "mic".into()).unwrap();
        assert!(opener.take().is_none(), "nothing was asked for");
        opener.ask(3);
        // A second ask before the take changes nothing.
        opener.ask(9);
        let prepared = opener.take().unwrap();
        assert_eq!(
            (prepared.seq, prepared.file.as_str()),
            (4, "audio/mic/000004.wav")
        );
        let writer = prepared.created.unwrap();
        assert_eq!(writer.samples(), 0);
        assert!(opener.take().is_none(), "taken once");
        drop(writer);
        // A file asked for and never taken comes back from finish.
        opener.ask(5);
        let left = opener.finish().unwrap();
        assert_eq!(left.seq, 5);
        drop(left);
        // After finish nothing is asked for any more.
        opener.ask(6);
        assert!(opener.take().is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
