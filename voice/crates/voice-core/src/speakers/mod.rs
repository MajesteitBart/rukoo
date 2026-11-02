//! Speaker labels on this computer: NVIDIA Nemotron 3 Diarization in the `rukoo-voice-speakers`
//! worker, whether it can run here, and the client the meeting pipeline talks to.
//!
//! The worker only turns audio into frame probabilities; turning those into speaker turns and
//! stable `call-N` ids happens in voice-meetings.

pub mod api;
mod availability;
mod client;
mod cpu;
mod runtime;

pub use api::*;
pub use availability::{SpeakerLabels, SpeakerOptions, Unavailable};
pub use cpu::{cpu_features, CpuFeatures};
pub use runtime::{locate_runtime, RuntimeInfo, RuntimeLocation};

#[cfg(test)]
pub(crate) mod tests {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    /// A folder under the system temp folder, removed when dropped.
    pub(crate) struct TempDir(PathBuf);

    impl TempDir {
        pub(crate) fn new(label: &str) -> TempDir {
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let count = COUNTER.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir()
                .join("voice-core-unit")
                .join(format!("{label}-{}-{count}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("create temp dir");
            TempDir(dir)
        }

        pub(crate) fn path(&self) -> &Path {
            &self.0
        }

        pub(crate) fn join(&self, part: &str) -> PathBuf {
            self.0.join(part)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}
