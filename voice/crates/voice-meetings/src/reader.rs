//! A track's audio by meeting time, read from its segment files while they grow.
//!
//! A track is a row of segments, each starting at the meeting time in its `segment` line. Between
//! them are gaps (a lost device, a crash, a pause), which read as silence. Neighbouring segments
//! can overlap by about 0.1 s when the recorder corrects device-clock drift; the earlier segment
//! keeps the overlap and the later one is read from just after it (voice/RECORDING.md, "Reading").
//!
//! Positions are meeting samples: meeting milliseconds times 16.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use voice_audio::{segment_header, HEADER_LEN};
use voice_recorder::timeline::SegmentRecord;

/// Samples per meeting millisecond.
pub const PER_MS: u64 = 16;

/// The part of one segment file that the track plays.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Piece {
    /// Meeting sample of the first sample played.
    at: u64,
    path: PathBuf,
    /// Samples at the start of the file that an earlier segment already covers.
    skip: u64,
    len: u64,
}

impl Piece {
    fn end(&self) -> u64 {
        self.at + self.len
    }
}

/// Reads one track of a meeting folder by meeting time.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TrackReader {
    pieces: Vec<Piece>,
}

impl TrackReader {
    /// The reader for `track`, from the timeline's segments of every track. The samples of each
    /// segment come from [`segment_samples`].
    pub fn new(dir: &Path, track: &str, segments: &[SegmentRecord]) -> TrackReader {
        TrackReader::with_lengths(dir, track, segments, |s| {
            segment_samples(&dir.join(&s.file), s.ended)
        })
    }

    /// [`TrackReader::new`] with the samples of each segment from `samples`, so a caller can keep
    /// the lengths of closed segments instead of reading their headers again.
    pub fn with_lengths(
        dir: &Path,
        track: &str,
        segments: &[SegmentRecord],
        mut samples: impl FnMut(&SegmentRecord) -> u64,
    ) -> TrackReader {
        let mut mine: Vec<&SegmentRecord> = segments.iter().filter(|s| s.track == track).collect();
        // Segment numbers count up in recording order, across sessions too.
        mine.sort_by_key(|s| s.seq);
        let mut pieces: Vec<Piece> = Vec::new();
        let mut covered_to: u64 = 0;
        for s in mine {
            let len = samples(s);
            let start = s.t * PER_MS;
            let skip = covered_to.saturating_sub(start);
            if len <= skip {
                continue;
            }
            let piece = Piece {
                at: start + skip,
                path: dir.join(&s.file),
                skip,
                len: len - skip,
            };
            covered_to = piece.end();
            pieces.push(piece);
        }
        TrackReader { pieces }
    }

    /// The meeting sample just after the last recorded sample, or 0 without audio.
    pub fn end(&self) -> u64 {
        self.pieces.last().map_or(0, Piece::end)
    }

    /// Whether the track has audio at `at`.
    pub fn covered(&self, at: u64) -> bool {
        self.pieces.iter().any(|p| p.at <= at && at < p.end())
    }

    /// The first position at or after `at` that has audio.
    pub fn next_audio(&self, at: u64) -> Option<u64> {
        self.pieces
            .iter()
            .find(|p| p.end() > at)
            .map(|p| p.at.max(at))
    }

    /// The end of the stretch of audio that holds `at`: neighbouring segments less than
    /// `tolerance` apart count as one stretch, since drift correction leaves gaps of about 0.1 s.
    /// `None` when there is no audio at `at`.
    pub fn span_end(&self, at: u64, tolerance: u64) -> Option<u64> {
        let first = self
            .pieces
            .iter()
            .position(|p| p.at <= at && at < p.end())?;
        let mut end = self.pieces[first].end();
        for p in &self.pieces[first + 1..] {
            if p.at > end + tolerance {
                break;
            }
            end = end.max(p.end());
        }
        Some(end)
    }

    /// Samples `from..to`, with silence where the track has no audio.
    pub fn read(&self, from: u64, to: u64) -> io::Result<Vec<i16>> {
        let mut out = vec![0i16; to.saturating_sub(from) as usize];
        for p in &self.pieces {
            let (a, b) = (p.at.max(from), p.end().min(to));
            if a >= b {
                continue;
            }
            let mut file = File::open(&p.path)?;
            file.seek(SeekFrom::Start(HEADER_LEN + (p.skip + a - p.at) * 2))?;
            let mut bytes = vec![0u8; ((b - a) * 2) as usize];
            let got = read_up_to(&mut file, &mut bytes)?;
            let dest = &mut out[(a - from) as usize..];
            for (sample, pair) in dest.iter_mut().zip(bytes[..got].chunks_exact(2)) {
                *sample = i16::from_le_bytes([pair[0], pair[1]]);
            }
        }
        Ok(out)
    }
}

/// Reads until `buf` is full or the file ends; returns the bytes read.
fn read_up_to(file: &mut File, buf: &mut [u8]) -> io::Result<usize> {
    let mut got = 0;
    while got < buf.len() {
        match file.read(&mut buf[got..]) {
            Ok(0) => break,
            Ok(n) => got += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(got)
}

/// The samples of a segment that can be read now.
///
/// `ended` is the count in its `segment_end` line. Without one the segment may still be growing:
/// only what its header counts is read, because the recorder writes the samples first and the
/// header after them. A header that counts nothing yet reads as empty. A missing file, or one
/// that isn't a segment the recorder wrote, reads as empty too.
pub fn segment_samples(path: &Path, ended: Option<u64>) -> u64 {
    let Ok(mut file) = File::open(path) else {
        return 0;
    };
    let Ok(len) = file.metadata().map(|m| m.len()) else {
        return 0;
    };
    let mut header = [0u8; HEADER_LEN as usize];
    if len < HEADER_LEN || file.read_exact(&mut header).is_err() || !is_segment_header(&header) {
        return 0;
    }
    let on_disk = (len - HEADER_LEN) / 2;
    match ended {
        Some(samples) => samples.min(on_disk),
        None => match u32::from_le_bytes([header[40], header[41], header[42], header[43]]) {
            0 | u32::MAX => 0,
            data => (u64::from(data) / 2).min(on_disk),
        },
    }
}

/// The canonical 16 kHz mono 16-bit header, whatever its two size fields say.
fn is_segment_header(header: &[u8; 44]) -> bool {
    let canonical = segment_header(0);
    header[0..4] == canonical[0..4] && header[8..40] == canonical[8..40]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    use voice_audio::SegmentWriter;

    fn segment(dir: &Path, track: &str, seq: u64, t: u64, pcm: &[i16]) -> SegmentRecord {
        let file = voice_recorder::meeting::segment_file(track, seq);
        let path = dir.join(&file);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut w = SegmentWriter::create(&path).unwrap();
        w.append(pcm).unwrap();
        let samples = w.close().unwrap();
        SegmentRecord {
            track: track.into(),
            seq,
            t,
            file,
            ended: Some(samples),
        }
    }

    #[test]
    fn reads_across_gaps_and_trims_overlaps() {
        let tmp = TempDir::new("reader");
        let dir = tmp.path();
        // mic: 100 ms of 1s at t=0, 100 ms of 2s at t=90 (10 ms overlap), then 3s at t=300.
        let segs = vec![
            segment(dir, "mic", 1, 0, &[1; 1600]),
            segment(dir, "mic", 2, 90, &[2; 1600]),
            segment(dir, "call", 1, 0, &[9; 160]),
            segment(dir, "mic", 3, 300, &[3; 800]),
        ];
        let r = TrackReader::new(dir, "mic", &segs);
        assert_eq!(r.end(), 350 * PER_MS);
        let all = r.read(0, r.end()).unwrap();
        assert_eq!(all.len(), 5600);
        assert!(all[..1600].iter().all(|&s| s == 1));
        // The second segment loses its first 10 ms to the first.
        assert!(all[1600..3040].iter().all(|&s| s == 2));
        assert!(all[3040..4800].iter().all(|&s| s == 0), "a gap is silence");
        assert!(all[4800..].iter().all(|&s| s == 3));
        assert_eq!(r.read(4700, 4900).unwrap()[..100], [0; 100]);
        assert!(r.covered(0) && r.covered(3039) && !r.covered(3040) && r.covered(4800));
        assert_eq!(r.next_audio(3040), Some(4800));
        assert_eq!(r.next_audio(10), Some(10));
        assert_eq!(r.next_audio(5600), None);
        assert_eq!(
            r.span_end(5, 0),
            Some(3040),
            "overlapping segments are one stretch"
        );
        assert_eq!(r.span_end(3040, 0), None);
        assert_eq!(
            r.span_end(5, 1760),
            Some(5600),
            "a gap within the tolerance joins"
        );
        assert_eq!(r.span_end(4800, 0), Some(5600));
        // Reading past the end gives silence.
        assert_eq!(r.read(5500, 5700).unwrap()[100..], [0; 100]);
        assert_eq!(TrackReader::new(dir, "nothing", &segs).end(), 0);
    }

    #[test]
    fn a_growing_segment_counts_what_its_header_counts() {
        let tmp = TempDir::new("reader-growing");
        let path = tmp.path().join("000001.wav");
        let mut w = SegmentWriter::create(&path).unwrap();
        assert_eq!(segment_samples(&path, None), 0);
        w.append(&[5; 320]).unwrap();
        assert_eq!(
            segment_samples(&path, None),
            320,
            "read while the writer has it open"
        );
        drop(w);
        // Samples a killed writer appended but never counted aren't read until a segment_end
        // line says how many there are.
        {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new()
                .append(true)
                .open(&path)
                .unwrap();
            f.write_all(&[1, 0, 1, 0, 1]).unwrap();
        }
        assert_eq!(segment_samples(&path, None), 320);
        assert_eq!(segment_samples(&path, Some(322)), 322);
        assert_eq!(
            segment_samples(&path, Some(400)),
            322,
            "never more than the file holds"
        );
        assert_eq!(
            segment_samples(&tmp.path().join("missing.wav"), Some(10)),
            0
        );
        std::fs::write(tmp.path().join("bad.wav"), [0u8; 100]).unwrap();
        assert_eq!(segment_samples(&tmp.path().join("bad.wav"), Some(10)), 0);
    }
}
