//! Maps positions in one diarizer stream to meeting time.
//!
//! A stream hears only what it was fed: the call track without its gaps, a few seconds of zeros
//! at a gap so the model commits the audio before it, and after a restart a reel of known voices
//! out of meeting order. The clock keeps a piece table of what went in, so every stream sample
//! maps back to the meeting sample it came from. A port of Ownkey's `StreamClock`
//! (`meetings/streaming.py:16-47`) with explicit padding.
//!
//! Stream and meeting positions are both samples at 16 kHz.

/// A stretch of the stream: real audio from `meeting` on, or padding when `meeting` is `None`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Piece {
    stream: u64,
    meeting: Option<u64>,
    len: u64,
}

impl Piece {
    fn end(&self) -> u64 {
        self.stream + self.len
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StreamClock {
    pieces: Vec<Piece>,
    sent: u64,
}

impl StreamClock {
    pub fn new() -> StreamClock {
        StreamClock::default()
    }

    /// `len` samples of the track from meeting sample `meeting` went into the stream. Audio that
    /// continues the last piece in meeting time extends it; anything else starts a new piece.
    pub fn append(&mut self, meeting: u64, len: u64) {
        if len == 0 {
            return;
        }
        match self.pieces.last_mut() {
            Some(last) if last.meeting.is_some_and(|m| m + last.len == meeting) => last.len += len,
            _ => self.pieces.push(Piece {
                stream: self.sent,
                meeting: Some(meeting),
                len,
            }),
        }
        self.sent += len;
    }

    /// `len` samples of zeros that belong to no meeting time went into the stream.
    pub fn pad(&mut self, len: u64) {
        if len == 0 {
            return;
        }
        match self.pieces.last_mut() {
            Some(last) if last.meeting.is_none() => last.len += len,
            _ => self.pieces.push(Piece {
                stream: self.sent,
                meeting: None,
                len,
            }),
        }
        self.sent += len;
    }

    /// Samples pushed into the stream so far.
    pub fn sent(&self) -> u64 {
        self.sent
    }

    /// Whether the last thing pushed was real audio, so a gap after it still needs padding.
    pub fn last_is_real(&self) -> bool {
        self.pieces.last().is_some_and(|p| p.meeting.is_some())
    }

    /// The meeting sample of stream sample `stream`. Inside padding, an end (`ending`) maps to
    /// the end of the audio before it and a start to the start of the audio after it. `None`
    /// past what was sent, or when there is no such audio.
    pub fn at(&self, stream: u64, ending: bool) -> Option<u64> {
        if stream > self.sent || self.pieces.is_empty() {
            return None;
        }
        // An end that falls on the border of two pieces belongs to the earlier one.
        let index = if ending && stream > 0 {
            self.pieces.partition_point(|p| p.stream < stream) - 1
        } else {
            self.pieces.partition_point(|p| p.stream <= stream) - 1
        };
        let piece = self.pieces[index];
        if let Some(meeting) = piece.meeting {
            return Some(meeting + (stream - piece.stream).min(piece.len));
        }
        if ending {
            self.pieces[..index]
                .iter()
                .rev()
                .find_map(|p| p.meeting.map(|m| m + p.len))
        } else {
            self.pieces[index + 1..].iter().find_map(|p| p.meeting)
        }
    }

    /// The meeting ranges of the real audio in the stream range `from..to`, in stream order.
    pub fn split(&self, from: u64, to: u64) -> Vec<(u64, u64)> {
        self.pieces
            .iter()
            .filter_map(|p| {
                let meeting = p.meeting?;
                let (a, b) = (p.stream.max(from), p.end().min(to));
                (a < b).then(|| (meeting + a - p.stream, meeting + b - p.stream))
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contiguous_audio_is_one_piece() {
        let mut clock = StreamClock::new();
        clock.append(16_000, 1_600);
        clock.append(17_600, 1_600);
        clock.append(19_200, 800);
        assert_eq!(clock.pieces.len(), 1);
        assert_eq!(clock.sent(), 4_000);
        assert_eq!(clock.at(0, false), Some(16_000));
        assert_eq!(clock.at(2_000, true), Some(18_000));
        assert_eq!(clock.at(4_000, true), Some(20_000));
        assert!(clock.last_is_real());
        clock.append(20_000, 0);
        assert_eq!(clock.pieces.len(), 1);
    }

    #[test]
    fn a_gap_starts_a_new_piece() {
        let mut clock = StreamClock::new();
        clock.append(0, 1_600);
        // The track resumes 10 s later.
        clock.append(160_000, 1_600);
        assert_eq!(clock.pieces.len(), 2);
        assert_eq!(clock.at(800, false), Some(800));
        assert_eq!(clock.at(2_400, false), Some(160_800));
        // The border belongs to the earlier piece as an end and to the later one as a start.
        assert_eq!(clock.at(1_600, true), Some(1_600));
        assert_eq!(clock.at(1_600, false), Some(160_000));
    }

    #[test]
    fn padding_maps_ends_back_and_starts_forward() {
        let mut clock = StreamClock::new();
        clock.append(16_000, 1_600);
        clock.pad(1_600);
        clock.pad(1_600);
        assert_eq!(clock.pieces.len(), 2, "padding in a row is one piece");
        assert!(!clock.last_is_real());
        // Nothing follows the padding yet: a start in it maps nowhere.
        assert_eq!(clock.at(2_400, false), None);
        assert_eq!(clock.at(2_400, true), Some(17_600));
        clock.append(48_000, 1_600);
        assert_eq!(clock.at(2_400, false), Some(48_000));
        assert_eq!(clock.at(2_400, true), Some(17_600));
        assert_eq!(clock.at(4_800, false), Some(48_000));
        assert_eq!(clock.at(5_600, false), Some(48_800));
        // Padding first has no audio before it.
        let mut early = StreamClock::new();
        early.pad(100);
        assert_eq!(early.at(50, true), None);
        assert_eq!(early.at(50, false), None);
    }

    #[test]
    fn split_skips_padding_and_follows_jumps() {
        let mut clock = StreamClock::new();
        // A reel: 1 s from 30 s, 1 s from 10 s, padding, then 2 s from 50 s.
        clock.append(480_000, 16_000);
        clock.append(160_000, 16_000);
        clock.pad(8_000);
        clock.append(800_000, 32_000);
        assert_eq!(
            clock.split(8_000, 48_000),
            vec![(488_000, 496_000), (160_000, 176_000), (800_000, 808_000)]
        );
        assert_eq!(clock.split(32_000, 40_000), vec![]);
        assert_eq!(clock.split(0, clock.sent()).len(), 3);
    }

    #[test]
    fn past_what_was_sent_is_nothing() {
        let mut clock = StreamClock::new();
        assert_eq!(clock.at(0, false), None);
        clock.append(1_000, 500);
        assert_eq!(clock.at(501, true), None);
        assert_eq!(clock.at(500, true), Some(1_500));
        assert_eq!(clock.at(500, false), Some(1_500));
        assert_eq!(clock.at(0, true), Some(1_000));
    }
}
