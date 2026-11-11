//! The syncer: a thread of its own that puts the recorder's files on disk, so a slow disk never
//! holds up the recorder thread, its heartbeats or its audio.
//!
//! Jobs run in the order they were sent. A segment handed over when it closed is on disk before
//! any later sync of the timeline that describes it.

use std::fs::File;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::disk;
use crate::record::log;

/// A sync slower than this is logged, so a recording that stalls can be told from a slow disk.
pub const SLOW: Duration = Duration::from_millis(500);

/// Files to sync, each with what to call it in the log.
type Files = Vec<(String, File)>;

struct Job {
    files: Files,
    periodic: bool,
}

pub struct Syncer {
    jobs: Option<Sender<Job>>,
    thread: Option<JoinHandle<()>>,
    /// A periodic sync waits or runs.
    periodic: Arc<AtomicBool>,
}

impl Syncer {
    pub fn start() -> io::Result<Self> {
        let (jobs, rx) = mpsc::channel::<Job>();
        let periodic = Arc::new(AtomicBool::new(false));
        let running = periodic.clone();
        let thread = std::thread::Builder::new()
            .name("syncer".into())
            .spawn(move || {
                for job in rx {
                    for (what, file) in &job.files {
                        let started = Instant::now();
                        if let Err(e) = disk::sync(file) {
                            log(format_args!("can't sync {what}: {e}"));
                        }
                        let took = started.elapsed();
                        if took > SLOW {
                            log(format_args!("syncing {what} took {} ms", took.as_millis()));
                        }
                    }
                    // Closes the files handed over.
                    drop(job.files);
                    if job.periodic {
                        running.store(false, Ordering::Release);
                    }
                }
            })?;
        Ok(Self {
            jobs: Some(jobs),
            thread: Some(thread),
            periodic,
        })
    }

    /// Puts a file that the recorder no longer writes on disk, then closes it.
    pub fn close(&self, what: String, file: File) {
        self.send(Job {
            files: vec![(what, file)],
            periodic: false,
        });
    }

    /// Whether a periodic sync may be queued: the previous one is done. On a slow disk the
    /// periodic syncs never pile up, while every closed segment still gets its own.
    pub fn periodic_due(&self) -> bool {
        !self.periodic.load(Ordering::Acquire)
    }

    /// Puts files that stay open on disk, through handles of their own.
    pub fn periodic(&self, files: Files) {
        self.periodic.store(true, Ordering::Release);
        self.send(Job {
            files,
            periodic: true,
        });
    }

    fn send(&self, job: Job) {
        let sent = self
            .jobs
            .as_ref()
            .is_some_and(|jobs| jobs.send(job).is_ok());
        if !sent {
            log("the syncer stopped; a file wasn't synced");
        }
    }

    /// Waits until every file handed over is on disk.
    pub fn finish(&mut self) {
        drop(self.jobs.take());
        if let Some(thread) = self.thread.take() {
            if thread.join().is_err() {
                log("the syncer failed");
            }
        }
    }
}

impl Drop for Syncer {
    fn drop(&mut self) {
        self.finish();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(name: &str) -> (std::path::PathBuf, File) {
        let path = std::env::temp_dir().join(format!(
            "voice-recorder-syncer-{name}-{}-{}",
            std::process::id(),
            crate::clock::wall_ms()
        ));
        let file = File::create(&path).unwrap();
        (path, file)
    }

    #[test]
    fn finish_waits_for_every_file_it_was_handed() {
        let mut syncer = Syncer::start().unwrap();
        let (open, file_open) = temp_file("open");
        let (closed, file_closed) = temp_file("closed");
        assert!(syncer.periodic_due());
        syncer.periodic(vec![("open".into(), file_open.try_clone().unwrap())]);
        syncer.close("closed".into(), file_closed);
        syncer.finish();
        assert!(syncer.periodic_due(), "the periodic sync ran");
        std::fs::remove_file(&closed).unwrap();
        // After finish nothing is sent any more, and nothing panics.
        syncer.close("late".into(), file_open.try_clone().unwrap());
        drop(file_open);
        std::fs::remove_file(&open).unwrap();
    }
}
