//! `screen/screen.json`: how to reach the live screen process. Written after the `session`
//! line (temp name, then rename, like `recorder.json`) and removed on a clean stop. It holds
//! the control token, so it never syncs and never goes into a log.

use std::fmt;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

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

pub fn write(meeting: &Path, file: &ScreenFile) -> io::Result<()> {
    let _ = (meeting, file);
    todo!()
}

pub fn read(meeting: &Path) -> Option<ScreenFile> {
    let _ = meeting;
    todo!()
}

pub fn remove(meeting: &Path) {
    let _ = meeting;
    todo!()
}

/// The screen file, when its process answers `status` with its token within 1 s.
pub fn live(meeting: &Path) -> Option<ScreenFile> {
    let _ = meeting;
    todo!()
}
