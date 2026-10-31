//! `<data>/logs/app.log`: the app's log, and the engine's when it logs through the `log` crate. Settings'
//! "Open logs folder" shows it. It keeps one older file, `app.1.log`, so it can't fill the disk.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use log::{Level, LevelFilter, Log, Metadata, Record};

const MAX_BYTES: u64 = 5 * 1024 * 1024;

struct FileLog {
    file: Mutex<Option<File>>,
    echo: bool,
}

/// Our crates log from info up; Tauri, WebView2 and the rest only warnings and errors.
fn wanted(metadata: &Metadata) -> bool {
    let ours =
        metadata.target().starts_with("rukoo_voice") || metadata.target().starts_with("voice_");
    metadata.level() <= if ours { Level::Info } else { Level::Warn }
}

impl Log for FileLog {
    fn enabled(&self, metadata: &Metadata) -> bool {
        wanted(metadata)
    }

    fn log(&self, record: &Record) {
        if !wanted(record.metadata()) {
            return;
        }
        let line = format!(
            "{} {:<5} {}: {}\n",
            utc_stamp(now_ms()),
            record.level(),
            record.target(),
            record.args()
        );
        if self.echo {
            eprint!("{line}");
        }
        if let Ok(mut file) = self.file.lock() {
            if let Some(file) = file.as_mut() {
                let _ = file.write_all(line.as_bytes());
            }
        }
    }

    fn flush(&self) {
        if let Ok(mut file) = self.file.lock() {
            if let Some(file) = file.as_mut() {
                let _ = file.flush();
            }
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// `2026-10-30T19:05:01.123Z`.
pub fn utc_stamp(ms: u64) -> String {
    let secs = ms / 1000;
    let (h, m, s) = ((secs / 3600) % 24, (secs / 60) % 60, secs % 60);
    // Howard Hinnant's days-to-civil.
    let z = (secs / 86_400) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{h:02}:{m:02}:{s:02}.{:03}Z",
        ms % 1000
    )
}

fn open(dir: &Path) -> Option<File> {
    fs::create_dir_all(dir).ok()?;
    let path = dir.join("app.log");
    if fs::metadata(&path).is_ok_and(|m| m.len() > MAX_BYTES) {
        let _ = fs::rename(&path, dir.join("app.1.log"));
    }
    OpenOptions::new().create(true).append(true).open(path).ok()
}

/// Starts logging to `<logs_dir>/app.log`; a debug build also echoes to stderr.
pub fn init(logs_dir: &Path) -> PathBuf {
    let logger = FileLog {
        file: Mutex::new(open(logs_dir)),
        echo: cfg!(debug_assertions),
    };
    if log::set_boxed_logger(Box::new(logger)).is_ok() {
        log::set_max_level(LevelFilter::Info);
    }
    logs_dir.join("app.log")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stamps_are_utc_iso_dates() {
        assert_eq!(utc_stamp(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(utc_stamp(951_782_400_000), "2000-02-29T00:00:00.000Z");
        assert_eq!(utc_stamp(1_793_387_101_123), "2026-10-30T19:05:01.123Z");
    }

    #[test]
    fn only_our_crates_log_below_warnings() {
        let meta =
            |target: &'static str, level| Metadata::builder().target(target).level(level).build();
        assert!(wanted(&meta("rukoo_voice::pill", Level::Info)));
        assert!(wanted(&meta("voice_engine::pill", Level::Info)));
        assert!(!wanted(&meta("rukoo_voice::pill", Level::Debug)));
        assert!(!wanted(&meta("tao::platform_impl", Level::Info)));
        assert!(wanted(&meta("wry", Level::Warn)));
    }
}
