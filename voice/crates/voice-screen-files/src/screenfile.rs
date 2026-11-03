//! `screen/screen.json`: how to reach the live screen process. Written after the `session`
//! line (temp name, then rename, like `recorder.json`) and removed on a clean stop. It holds
//! the control token, so it never syncs and never goes into a log.

use std::fmt;
use std::io::{self, Write};
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{control, paths};

/// How long `live` waits for the process to answer `status`.
pub const LIVE_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenFile {
    pub pid: u32,
    pub port: u16,
    pub token: String,
    pub session: u64,
    pub started_at: u64,
}

impl fmt::Debug for ScreenFile {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Screen files end up in logs; the token must not.
        f.debug_struct("ScreenFile")
            .field("pid", &self.pid)
            .field("port", &self.port)
            .field("token", &"<redacted>")
            .field("session", &self.session)
            .field("started_at", &self.started_at)
            .finish()
    }
}

/// Writes `screen.json` to a temporary name, syncs it and renames it into place, so a reader
/// never sees half of it.
pub fn write(meeting: &Path, file: &ScreenFile) -> io::Result<()> {
    let dir = paths::screen_dir(meeting);
    std::fs::create_dir_all(&dir)?;
    let tmp = dir.join(format!("{}.tmp", paths::SCREEN_FILE));
    let bytes = serde_json::to_vec(file)?;
    {
        let mut out = std::fs::File::create(&tmp)?;
        out.write_all(&bytes)?;
        out.sync_data()?;
    }
    std::fs::rename(&tmp, paths::screen_file_path(meeting))
}

/// The screen file, when there is one that parses. It proves nothing about the process; see
/// `live`.
pub fn read(meeting: &Path) -> Option<ScreenFile> {
    let bytes = std::fs::read(paths::screen_file_path(meeting)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Removes the screen file; a missing one is fine.
pub fn remove(meeting: &Path) {
    let _ = std::fs::remove_file(paths::screen_file_path(meeting));
}

/// The screen file, when its process answers `status` with its token within 1 s. A stale file,
/// or another program that took the port since, doesn't count.
pub fn live(meeting: &Path) -> Option<ScreenFile> {
    let file = read(meeting)?;
    let reply = control::request(
        file.port,
        &file.token,
        json!({ "cmd": "status" }),
        LIVE_TIMEOUT,
    )
    .ok()?;
    (reply["ok"] == true).then_some(file)
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use super::*;
    use crate::testdir::TestDir;

    fn sample(port: u16, token: &str) -> ScreenFile {
        ScreenFile {
            pid: 18_220,
            port,
            token: token.into(),
            session: 1,
            started_at: 1_793_384_409_120,
        }
    }

    #[test]
    fn writes_reads_and_removes() {
        let dir = TestDir::new("screenfile");
        assert_eq!(read(dir.path()), None);
        let file = sample(51_603, "q7hR0lJ3x2b8Yc5vN1mK4sT9wE6uA0dF3gH2jL5pZ8o");
        write(dir.path(), &file).unwrap();
        assert_eq!(read(dir.path()), Some(file.clone()));
        let text = std::fs::read_to_string(paths::screen_file_path(dir.path())).unwrap();
        assert_eq!(
            text,
            r#"{"pid":18220,"port":51603,"token":"q7hR0lJ3x2b8Yc5vN1mK4sT9wE6uA0dF3gH2jL5pZ8o","session":1,"startedAt":1793384409120}"#
        );
        assert!(!paths::screen_dir(dir.path())
            .join("screen.json.tmp")
            .exists());
        // The token never shows in a log line.
        assert!(!format!("{file:?}").contains("q7hR"));
        remove(dir.path());
        assert_eq!(read(dir.path()), None);
        remove(dir.path());
    }

    #[test]
    fn live_needs_an_answer_with_the_token() {
        let dir = TestDir::new("screenfile-live");
        // Nothing listens on a port that was just closed.
        let port = {
            let listener = control::bind().unwrap();
            listener.local_addr().unwrap().port()
        };
        write(dir.path(), &sample(port, "stale")).unwrap();
        assert_eq!(live(dir.path()), None);

        let listener = control::bind().unwrap();
        let port = listener.local_addr().unwrap().port();
        let token = control::new_token().unwrap();
        let (to_main, requests) = mpsc::sync_channel::<control::Request>(1);
        control::serve(listener, token.clone(), to_main).unwrap();
        std::thread::spawn(move || {
            for request in requests {
                let _ = request
                    .reply
                    .send(json!({ "ok": true, "state": "recording" }));
            }
        });
        // Another token at that port is someone else.
        write(dir.path(), &sample(port, "not-the-token")).unwrap();
        assert_eq!(live(dir.path()), None);
        write(dir.path(), &sample(port, &token)).unwrap();
        assert_eq!(live(dir.path()).map(|f| f.port), Some(port));
    }
}
