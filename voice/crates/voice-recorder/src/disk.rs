//! Syncs to disk and segment creates. Every sync the recorder makes goes through [`sync`] and
//! every segment file it creates through [`create_segment`], so the test options
//! `--test-sync-delay-ms` and `--test-create-delay-ms` can make all of them slow, as on a busy
//! disk or under a virus scanner, and the tests can check that no time in the timeline and no
//! heartbeat depends on how long they take.

use std::fs::File;
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use voice_audio::SegmentWriter;

static TEST_DELAY_MS: AtomicU64 = AtomicU64::new(0);
static TEST_CREATE_DELAY_MS: AtomicU64 = AtomicU64::new(0);

/// Makes every later [`sync`] in this process wait `ms` first. Only tests set it.
pub fn set_test_delay(ms: u64) {
    TEST_DELAY_MS.store(ms, Ordering::Relaxed);
}

/// Makes every later [`create_segment`] in this process wait `ms` first. Only tests set it.
pub fn set_test_create_delay(ms: u64) {
    TEST_CREATE_DELAY_MS.store(ms, Ordering::Relaxed);
}

/// Asks the OS to put the file's data on the disk.
pub fn sync(file: &File) -> io::Result<()> {
    wait(&TEST_DELAY_MS);
    file.sync_data()
}

/// Creates a new segment file, refusing an existing one.
pub fn create_segment(path: &Path) -> io::Result<SegmentWriter> {
    wait(&TEST_CREATE_DELAY_MS);
    SegmentWriter::create(path)
}

fn wait(delay_ms: &AtomicU64) {
    let ms = delay_ms.load(Ordering::Relaxed);
    if ms > 0 {
        std::thread::sleep(Duration::from_millis(ms));
    }
}
