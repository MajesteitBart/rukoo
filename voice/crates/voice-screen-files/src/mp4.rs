//! A box walker for the fragmented MP4 files the screen process writes: index, repair and cut.
//!
//! Only complete `moof`+`mdat` pairs count. A cut starts at the latest fragment at or before
//! its start whose first sample is a sync sample, copies `ftyp`, `moov` and the fragments,
//! renumbers `mfhd` from 1 and rewrites each `tfhd.base_data_offset` for the new file.

use std::io::{self, Read, Seek};
use std::ops::Range;
use std::path::Path;

/// One `moof`+`mdat` pair. `start` and `duration` are in the track's timescale.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fragment {
    pub offset: u64,
    pub moof_size: u64,
    pub mdat_size: u64,
    pub start: u64,
    pub duration: u64,
    pub samples: u32,
    pub first_sync: bool,
    pub has_sync: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Index {
    pub timescale: u32,
    pub ftyp: Range<u64>,
    pub moov: Range<u64>,
    pub fragments: Vec<Fragment>,
    /// The end of the last complete box.
    pub complete_len: u64,
    pub file_len: u64,
}

/// Walks the boxes of `len` bytes; stops at the first incomplete box.
pub fn index(file: &mut (impl Read + Seek), len: u64) -> io::Result<Index> {
    let _ = (file, len);
    todo!()
}

pub fn index_path(path: &Path) -> io::Result<Index> {
    let _ = path;
    todo!()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Repaired {
    pub kept: u64,
    pub cut: u64,
}

/// Truncates the file to its last complete box.
pub fn repair(path: &Path) -> io::Result<Repaired> {
    let _ = path;
    todo!()
}

/// What a cut holds, in ms of the source file's media time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cut {
    pub start_ms: u64,
    pub end_ms: u64,
    pub bytes: u64,
}

/// Copies the fragments covering `[from_ms, to_ms]` of `src` into `dst`. `None` when no complete
/// fragment overlaps the range.
pub fn cut(src: &Path, from_ms: u64, to_ms: u64, dst: &Path) -> io::Result<Option<Cut>> {
    let _ = (src, from_ms, to_ms, dst);
    todo!()
}

/// Each fragment's duration in ms.
pub fn fragment_ms(index: &Index) -> Vec<u64> {
    let _ = index;
    todo!()
}
