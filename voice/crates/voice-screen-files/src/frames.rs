//! When a frame is saved, the text kept with it, and the index of saved frames.
//!
//! A frame is saved when at least `CHANGE` of the 1/8-scale luma pixels changed by more than
//! `PIXEL_DELTA` levels against the last saved frame, once the screen is still for `SETTLE_MS`
//! or `MAX_PENDING_MS` after the change began, at most one per `MIN_GAP_MS`, backing off to one
//! per `BUSY_GAP_MS` after `BUSY_AFTER` saves in a row at the short pace. Always one at capture
//! start, after a monitor switch, an unlock and a resume (`Saver::reset`).

use std::io;
use std::path::Path;

use crate::journal::{self, Line};

/// A luma change above this many levels counts a pixel as changed.
pub const PIXEL_DELTA: u8 = 16;
/// The fraction of changed pixels that makes a frame worth saving.
pub const CHANGE: f32 = 0.01;
/// Below this fraction of changed pixels between two captures the screen counts as still.
pub const STILL: f32 = 0.002;
pub const SETTLE_MS: u64 = 700;
pub const MAX_PENDING_MS: u64 = 3_000;
pub const MIN_GAP_MS: u64 = 2_000;
pub const BUSY_GAP_MS: u64 = 10_000;
pub const BUSY_AFTER: u32 = 10;
/// Dirty regions covering less than this fraction of the screen skip the thumbnail.
pub const DIRTY_SKIP: f32 = 0.0025;
/// The most characters of text kept with a frame; `voice_protocol::MAX_FRAME_TEXT_CHARS`.
pub const MAX_TEXT_CHARS: usize = 8_000;
pub const JPEG_QUALITY: f32 = 0.75;
pub const JPEG_MAX_SIDE: u32 = 2560;

/// A 1/8-scale luma thumbnail, row by row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Thumb {
    pub width: u32,
    pub height: u32,
    pub luma: Vec<u8>,
}

/// The fraction of pixels that changed by more than `PIXEL_DELTA`. Thumbnails of different
/// sizes count as fully changed.
pub fn changed_fraction(a: &Thumb, b: &Thumb) -> f32 {
    let n = a.luma.len();
    if a.width != b.width || a.height != b.height || n != b.luma.len() {
        return 1.0;
    }
    if n == 0 {
        return 0.0;
    }
    let changed = a
        .luma
        .iter()
        .zip(&b.luma)
        .filter(|(x, y)| x.abs_diff(**y) > PIXEL_DELTA)
        .count();
    changed as f32 / n as f32
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Skip,
    Save,
}

/// Decides which captured frames to save. Pure: times are meeting ms.
///
/// Call `offer` for every frame the capture hands over, also for a still screen re-offered on a
/// timer, because a pending change is saved only once an offer finds the screen settled. Call
/// `saved` when a `Save` was saved.
#[derive(Debug)]
pub struct Saver {
    /// The last saved frame: what a change is measured against. `None` after `reset`.
    last_saved: Option<(u64, Thumb)>,
    /// When the last save happened, kept across `reset` for the pace.
    last_save_t: Option<u64>,
    /// The last offered thumbnail, for telling a still screen.
    previous: Option<Thumb>,
    /// When a change against the last saved frame was first seen.
    pending_since: Option<u64>,
    /// When the screen last moved between two offers.
    still_since: Option<u64>,
    /// Saves in a row that came at the current pace.
    streak: u32,
}

impl Saver {
    pub fn new() -> Saver {
        Saver {
            last_saved: None,
            last_save_t: None,
            previous: None,
            pending_since: None,
            still_since: None,
            streak: 0,
        }
    }

    /// The next offer saves.
    pub fn reset(&mut self) {
        self.last_saved = None;
        self.previous = None;
        self.pending_since = None;
        self.still_since = None;
    }

    /// A captured frame at `t`. `dirty` is the fraction of the screen its dirty regions cover,
    /// when the capture reports them; below `DIRTY_SKIP` the frame counts as the previous one
    /// and `thumb` isn't looked at.
    pub fn offer(&mut self, t: u64, thumb: &Thumb, dirty: Option<f32>) -> Decision {
        let unchanged = dirty.is_some_and(|d| d < DIRTY_SKIP) && self.previous.is_some();
        if !unchanged {
            let moved = self
                .previous
                .as_ref()
                .map_or(1.0, |p| changed_fraction(p, thumb));
            if moved >= STILL {
                self.still_since = Some(t);
            }
            self.previous = Some(thumb.clone());
        }
        let still_since = *self.still_since.get_or_insert(t);
        let Some((saved_t, saved)) = &self.last_saved else {
            return Decision::Save;
        };
        let current = self.previous.as_ref().unwrap_or(thumb);
        if changed_fraction(saved, current) < CHANGE {
            // Back to what was saved: nothing to save, and a later change starts afresh.
            self.pending_since = None;
            return Decision::Skip;
        }
        let pending_since = *self.pending_since.get_or_insert(t);
        let settled = t.saturating_sub(still_since) >= SETTLE_MS;
        let overdue = t.saturating_sub(pending_since) >= MAX_PENDING_MS;
        let paced = t.saturating_sub(*saved_t) >= self.gap();
        if (settled || overdue) && paced {
            Decision::Save
        } else {
            Decision::Skip
        }
    }

    /// The frame offered at `t` was saved.
    pub fn saved(&mut self, t: u64, thumb: Thumb) {
        // A save that came within a short pace of the one before keeps the streak going; one
        // after a quiet stretch ends it, and the short pace comes back.
        self.streak = match self.last_save_t {
            Some(last) if t.saturating_sub(last) < self.gap() + MIN_GAP_MS => {
                self.streak.saturating_add(1)
            }
            _ => 0,
        };
        self.last_save_t = Some(t);
        self.pending_since = None;
        self.previous = Some(thumb.clone());
        self.last_saved = Some((t, thumb));
    }

    /// The least time between two saves now.
    fn gap(&self) -> u64 {
        if self.streak >= BUSY_AFTER {
            BUSY_GAP_MS
        } else {
            MIN_GAP_MS
        }
    }
}

impl Default for Saver {
    fn default() -> Saver {
        Saver::new()
    }
}

/// Trims each line, collapses runs of spaces, drops empty lines, joins with `\n` and cuts at
/// `MAX_TEXT_CHARS` characters.
pub fn clean_text(raw_lines: &[String]) -> String {
    let mut out = String::new();
    let mut chars = 0;
    for line in raw_lines.iter().flat_map(|l| l.split(['\n', '\r'])) {
        let mut words = line.split_whitespace().peekable();
        if words.peek().is_none() {
            continue;
        }
        if !out.is_empty() {
            if chars + 1 > MAX_TEXT_CHARS {
                break;
            }
            out.push('\n');
            chars += 1;
        }
        let mut first = true;
        for word in words {
            if !first {
                if chars + 1 > MAX_TEXT_CHARS {
                    return out.trim_end().to_string();
                }
                out.push(' ');
                chars += 1;
            }
            first = false;
            for c in word.chars() {
                if chars == MAX_TEXT_CHARS {
                    return out.trim_end().to_string();
                }
                out.push(c);
                chars += 1;
            }
        }
    }
    out.trim_end().to_string()
}

/// A journaled frame.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FrameEntry {
    pub id: String,
    pub t: u64,
    /// Relative to the meeting folder.
    pub file: String,
    pub width: u32,
    pub height: u32,
    pub text: String,
}

/// The journal's frames, sorted by `t`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FrameIndex {
    entries: Vec<FrameEntry>,
}

impl FrameIndex {
    /// The `frame` lines, sorted by `t`. A frame journaled twice, by id, counts once, with its
    /// last line.
    pub fn from_lines(lines: &[Line]) -> FrameIndex {
        let mut entries: Vec<FrameEntry> = Vec::new();
        let mut at: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        for line in lines {
            if let Line::Frame {
                t,
                id,
                file,
                width,
                height,
                text,
                ..
            } = line
            {
                let entry = FrameEntry {
                    id: id.clone(),
                    t: *t,
                    file: file.clone(),
                    width: *width,
                    height: *height,
                    text: text.clone(),
                };
                match at.get(id) {
                    Some(&i) => entries[i] = entry,
                    None => {
                        at.insert(id.clone(), entries.len());
                        entries.push(entry);
                    }
                }
            }
        }
        entries.sort_by_key(|e| e.t);
        FrameIndex { entries }
    }

    pub fn load(meeting: &Path) -> io::Result<FrameIndex> {
        Ok(FrameIndex::from_lines(&journal::read_all(meeting)?))
    }

    /// The last frame with `t <= at`.
    pub fn at_or_before(&self, at: u64) -> Option<&FrameEntry> {
        let end = self.entries.partition_point(|e| e.t <= at);
        end.checked_sub(1).map(|i| &self.entries[i])
    }

    /// The frames with `from <= t <= to`.
    pub fn between(&self, from: u64, to: u64) -> &[FrameEntry] {
        if from > to {
            return &[];
        }
        let start = self.entries.partition_point(|e| e.t < from);
        let end = self.entries.partition_point(|e| e.t <= to);
        &self.entries[start..end]
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Every frame, oldest first.
    pub fn entries(&self) -> &[FrameEntry] {
        &self.entries
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths;

    /// A 16 x 10 thumbnail of pseudo-random noise: two different seeds differ almost everywhere.
    fn noise(seed: u32) -> Thumb {
        // splitmix64 of (seed, pixel): every pixel independent of the others and of other seeds.
        let luma = (0..160u64)
            .map(|i| {
                let mut z = (u64::from(seed) << 32 | i).wrapping_add(0x9e37_79b9_7f4a_7c15);
                z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
                z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
                (z ^ (z >> 31)) as u8
            })
            .collect();
        Thumb {
            width: 16,
            height: 10,
            luma,
        }
    }

    /// Offers `(t, thumb)` in order, saving whatever the saver asks for; returns the save times.
    fn run(saver: &mut Saver, frames: impl IntoIterator<Item = (u64, Thumb)>) -> Vec<u64> {
        let mut saved = Vec::new();
        for (t, thumb) in frames {
            if saver.offer(t, &thumb, None) == Decision::Save {
                saver.saved(t, thumb);
                saved.push(t);
            }
        }
        saved
    }

    /// One offer every 100 ms from `from` to `to`, showing `seed_at(t)`.
    fn every_100ms(from: u64, to: u64, seed_at: impl Fn(u64) -> u32) -> Vec<(u64, Thumb)> {
        (from..to)
            .step_by(100)
            .map(|t| (t, noise(seed_at(t))))
            .collect()
    }

    #[test]
    fn changed_fraction_counts_pixels_beyond_the_delta() {
        let a = Thumb {
            width: 4,
            height: 1,
            luma: vec![0, 100, 200, 255],
        };
        let mut b = a.clone();
        assert_eq!(changed_fraction(&a, &b), 0.0);
        b.luma = vec![16, 117, 200, 0];
        // +16 isn't a change, +17 and -255 are.
        assert_eq!(changed_fraction(&a, &b), 0.5);
        let other_size = Thumb {
            width: 2,
            height: 2,
            luma: vec![0, 100, 200, 255],
        };
        assert_eq!(changed_fraction(&a, &other_size), 1.0);
        let empty = Thumb {
            width: 0,
            height: 0,
            luma: vec![],
        };
        assert_eq!(changed_fraction(&empty, &empty), 0.0);
        assert!(changed_fraction(&noise(1), &noise(2)) > 0.5);
    }

    #[test]
    fn the_first_frame_is_saved_and_a_still_screen_adds_nothing() {
        let mut saver = Saver::new();
        assert_eq!(run(&mut saver, every_100ms(0, 20_000, |_| 7)), vec![0]);
    }

    #[test]
    fn a_change_is_saved_once_the_screen_is_still_for_700_ms() {
        let mut saver = Saver::new();
        // A slide changes at 5 s and stays.
        let saves = run(
            &mut saver,
            every_100ms(0, 10_000, |t| if t < 5_000 { 1 } else { 2 }),
        );
        assert_eq!(saves, vec![0, 5_700]);
    }

    #[test]
    fn a_screen_that_keeps_moving_is_saved_after_3_s() {
        let mut saver = Saver::new();
        // Still until 5 s, then a different picture every 100 ms.
        let saves = run(
            &mut saver,
            every_100ms(0, 9_000, |t| if t < 5_000 { 1 } else { t as u32 }),
        );
        assert_eq!(saves, vec![0, 8_000]);
    }

    #[test]
    fn saves_are_at_least_2_s_apart() {
        let mut saver = Saver::new();
        // A slide at 0.5 s settles at 1.2 s, but the first save was at 0.
        let saves = run(
            &mut saver,
            every_100ms(0, 5_000, |t| if t < 500 { 1 } else { 2 }),
        );
        assert_eq!(saves, vec![0, 2_000]);
    }

    #[test]
    fn a_change_back_cancels_the_pending_save() {
        let mut saver = Saver::new();
        // A tooltip shows for 400 ms and goes; then the slide changes at 6 s.
        let saves = run(
            &mut saver,
            every_100ms(0, 9_000, |t| match t {
                3_000..=3_400 => 2,
                0..=5_999 => 1,
                _ => 3,
            }),
        );
        assert_eq!(saves, vec![0, 6_700]);
        // Pending since the tooltip, it would be overdue at 6 s without the cancel.
        let mut saver = Saver::new();
        run(
            &mut saver,
            every_100ms(0, 3_400, |t| if t < 3_000 { 1 } else { 2 }),
        );
        assert_eq!(saver.pending_since, Some(3_000));
        run(&mut saver, every_100ms(3_400, 3_600, |_| 1));
        assert_eq!(saver.pending_since, None);
    }

    #[test]
    fn a_busy_screen_backs_off_to_one_frame_in_10_s() {
        let mut saver = Saver::new();
        // Shared video: a new picture every 100 ms for two minutes.
        let saves = run(&mut saver, every_100ms(0, 120_000, |t| t as u32 + 1));
        let gaps: Vec<u64> = saves.windows(2).map(|w| w[1] - w[0]).collect();
        // The 3 s rule saves, BUSY_AFTER times in a row at the short pace, then every 10 s.
        assert!(gaps[..BUSY_AFTER as usize]
            .iter()
            .all(|&g| (MIN_GAP_MS..=MAX_PENDING_MS + 100).contains(&g)));
        assert!(
            gaps[BUSY_AFTER as usize..]
                .iter()
                .all(|&g| (BUSY_GAP_MS..BUSY_GAP_MS + MIN_GAP_MS).contains(&g)),
            "{gaps:?}"
        );
        assert!(gaps.len() > BUSY_AFTER as usize + 3, "{saves:?}");

        // Calm for a minute, then two slides: the short pace is back.
        let calm_from = 120_000;
        let still = noise(1_000_000);
        let mut tail: Vec<(u64, Thumb)> = (calm_from..calm_from + 60_000)
            .step_by(100)
            .map(|t| (t, still.clone()))
            .collect();
        let slide_at = calm_from + 60_000;
        tail.extend(every_100ms(slide_at, slide_at + 1_000, |_| 2_000_000));
        tail.extend(every_100ms(slide_at + 1_000, slide_at + 4_000, |_| {
            3_000_000
        }));
        let more = run(&mut saver, tail);
        // The change still pending from the video, once the 10 s pace allows it; then after the
        // quiet minute both slides, 2 s apart.
        assert_eq!(more.len(), 3, "{more:?}");
        assert_eq!(more[0], saves.last().unwrap() + BUSY_GAP_MS);
        assert_eq!(more[1], slide_at + SETTLE_MS);
        assert_eq!(more[2], more[1] + MIN_GAP_MS);
    }

    #[test]
    fn reset_saves_the_next_frame_at_once() {
        let mut saver = Saver::new();
        run(&mut saver, every_100ms(0, 1_000, |_| 1));
        saver.reset();
        assert_eq!(saver.offer(1_000, &noise(1), None), Decision::Save);
        saver.saved(1_000, noise(1));
        assert_eq!(saver.offer(1_100, &noise(2), None), Decision::Skip);
    }

    #[test]
    fn small_dirty_regions_count_as_no_change() {
        let mut saver = Saver::new();
        assert_eq!(saver.offer(0, &noise(1), None), Decision::Save);
        saver.saved(0, noise(1));
        // The capture says almost nothing changed, whatever the thumbnail says.
        for t in (100..3_000).step_by(100) {
            assert_eq!(
                saver.offer(t, &noise(t as u32), Some(0.001)),
                Decision::Skip
            );
        }
        // A real change, then a still screen reported through dirty regions.
        assert_eq!(saver.offer(3_000, &noise(2), Some(0.3)), Decision::Skip);
        assert_eq!(saver.offer(3_500, &noise(99), Some(0.0)), Decision::Skip);
        assert_eq!(saver.offer(3_700, &noise(99), Some(0.0)), Decision::Save);
    }

    #[test]
    fn text_is_cleaned_and_capped() {
        let raw: Vec<String> = [
            "  Q3   roadmap ",
            "",
            "   ",
            "Revenue\tup\u{a0}12%",
            "two\nlines",
        ]
        .map(String::from)
        .to_vec();
        assert_eq!(clean_text(&raw), "Q3 roadmap\nRevenue up 12%\ntwo\nlines");
        assert_eq!(clean_text(&[]), "");
        // Multi-byte characters count as one each.
        let long = vec!["é".repeat(MAX_TEXT_CHARS + 50)];
        let cut = clean_text(&long);
        assert_eq!(cut.chars().count(), MAX_TEXT_CHARS);
        assert!(cut.len() > MAX_TEXT_CHARS);
        let many: Vec<String> = (0..5_000).map(|i| format!("line {i}")).collect();
        let cut = clean_text(&many);
        assert!(cut.chars().count() <= MAX_TEXT_CHARS);
        assert!(!cut.ends_with(['\n', ' ']));
        assert!(cut.starts_with("line 0\nline 1\n"));
    }

    #[test]
    fn limits_match_the_protocol() {
        assert_eq!(MAX_TEXT_CHARS, voice_protocol::MAX_FRAME_TEXT_CHARS);
    }

    fn frame_line(t: u64, text: &str) -> Line {
        let id = paths::frame_id(t);
        Line::Frame {
            t,
            file: paths::frame_file(&id),
            id,
            width: 1920,
            height: 1080,
            text: text.into(),
            ocr: "ok".into(),
            language: None,
        }
    }

    #[test]
    fn the_index_answers_at_or_before_and_between() {
        // Out of order, as a resumed session journals orphan JPEGs late, and one journaled twice.
        let lines = vec![
            frame_line(5_000, "b"),
            Line::Lock { t: 6_000 },
            frame_line(1_000, "a"),
            frame_line(9_000, "c"),
            frame_line(5_000, "b again"),
        ];
        let index = FrameIndex::from_lines(&lines);
        assert_eq!(index.len(), 3);
        assert!(!index.is_empty());
        let ts: Vec<u64> = index.entries().iter().map(|e| e.t).collect();
        assert_eq!(ts, vec![1_000, 5_000, 9_000]);
        assert_eq!(index.at_or_before(999), None);
        assert_eq!(index.at_or_before(1_000).unwrap().text, "a");
        assert_eq!(index.at_or_before(4_999).unwrap().t, 1_000);
        assert_eq!(index.at_or_before(5_000).unwrap().text, "b again");
        assert_eq!(index.at_or_before(u64::MAX).unwrap().t, 9_000);
        assert_eq!(index.between(1_000, 5_000).len(), 2);
        assert_eq!(index.between(1_001, 8_999).len(), 1);
        assert_eq!(index.between(9_001, 20_000).len(), 0);
        assert_eq!(index.between(5_000, 1_000).len(), 0);
        assert!(FrameIndex::from_lines(&[]).is_empty());
        assert_eq!(FrameIndex::default().at_or_before(0), None);
    }
}
