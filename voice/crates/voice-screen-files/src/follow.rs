//! Reading a growing JSON-lines file with the recorder's rules: only complete lines count, a
//! line that doesn't parse is skipped.
//!
//! The offset always sits after the last complete line read, never inside a partial one: a
//! writer that starts again cuts off a torn last line before it appends, so a partial line is
//! read again from its start on the next poll instead of being glued to what replaces it.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;

#[derive(Debug)]
pub(crate) struct Follower {
    path: PathBuf,
    offset: u64,
}

impl Follower {
    pub(crate) fn new(path: PathBuf) -> Follower {
        Follower { path, offset: 0 }
    }

    /// The complete lines written since the last poll that parse as `T`. A missing file reads
    /// as nothing yet.
    pub(crate) fn poll<T: DeserializeOwned>(&mut self) -> io::Result<Vec<T>> {
        let mut file = match File::open(&self.path) {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e),
        };
        let len = file.metadata()?.len();
        if len < self.offset {
            // Replaced by a shorter file, such as a restore: read it again from the start.
            self.offset = 0;
        }
        if len == self.offset {
            return Ok(Vec::new());
        }
        file.seek(SeekFrom::Start(self.offset))?;
        let mut bytes = Vec::with_capacity((len - self.offset) as usize);
        file.take(len - self.offset).read_to_end(&mut bytes)?;
        let (lines, consumed) = parse_complete(&bytes);
        self.offset += consumed as u64;
        Ok(lines)
    }
}

/// Every complete line of `bytes` that parses, and how many bytes the complete lines take.
pub(crate) fn parse_complete<T: DeserializeOwned>(bytes: &[u8]) -> (Vec<T>, usize) {
    let Some(last) = bytes.iter().rposition(|&b| b == b'\n') else {
        return (Vec::new(), 0);
    };
    let lines = bytes[..last]
        .split(|&b| b == b'\n')
        .filter_map(|line| {
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            if line.iter().all(u8::is_ascii_whitespace) {
                return None;
            }
            serde_json::from_slice(line).ok()
        })
        .collect();
    (lines, last + 1)
}

/// Every complete line of the file that parses; a missing file reads as none.
pub(crate) fn read_all<T: DeserializeOwned>(path: &Path) -> io::Result<Vec<T>> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(parse_complete(&bytes).0),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e),
    }
}
