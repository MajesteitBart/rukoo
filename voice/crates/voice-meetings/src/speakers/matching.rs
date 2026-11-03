//! Keeps speaker ids stable when labelling starts a new stream: after a worker crash, an app
//! restart or a pipeline restart.
//!
//! A new stream numbers voices in its own way. Before it hears the live call, it gets a reel: a
//! few seconds of each voice the meeting already knows, then the 20 s before the settled position.
//! The labels the stream gives the reel's audio are matched to the stored `call-N` ids by how
//! much their turns overlap in meeting time. A voice silent for a while still gets matched
//! through its piece of the reel.
//!
//! Positions are meeting samples unless a name says ms.

use std::collections::{HashMap, HashSet};

use crate::reader::{TrackReader, PER_MS};
use crate::speakers::turns::Turn;
use crate::transcript::call_number;

/// The most known voices a reel holds.
pub const REEL_SPEAKERS: usize = 8;
/// Solo speech per voice in the reel.
pub const REEL_PER_SPEAKER_MS: u64 = 8_000;
/// A solo stretch shorter than this isn't used.
pub const REEL_MIN_STRETCH_MS: u64 = 1_000;
/// The audio before the settled position at the end of the reel.
pub const REEL_TAIL_MS: u64 = 20_000;
/// A label and an id must overlap at least this long to match.
pub const MATCH_MIN_MS: u64 = 500;
/// And for at least this share of the label's speech in the reel.
pub const MATCH_MIN_SHARE: f64 = 0.3;

/// The stretches of audio the track has before `until`.
fn audio_spans(reader: &TrackReader, until: u64) -> Vec<(u64, u64)> {
    let mut spans = Vec::new();
    let mut at = 0;
    while let Some(start) = reader.next_audio(at) {
        if start >= until {
            break;
        }
        let end = reader.span_end(start, 0).unwrap_or(start).min(until);
        if end <= start {
            break;
        }
        spans.push((start, end));
        at = end;
    }
    spans
}

/// `ranges` minus `cut`, both sorted and without overlaps of their own.
fn subtract(ranges: &[(u64, u64)], cut: &[(u64, u64)]) -> Vec<(u64, u64)> {
    let mut out = Vec::new();
    for &(mut a, b) in ranges {
        for &(c, d) in cut {
            if d <= a || c >= b {
                continue;
            }
            if c > a {
                out.push((a, c));
            }
            a = a.max(d);
            if a >= b {
                break;
            }
        }
        if a < b {
            out.push((a, b));
        }
    }
    out
}

fn intersect(ranges: &[(u64, u64)], with: &[(u64, u64)]) -> Vec<(u64, u64)> {
    let mut out = Vec::new();
    for &(a, b) in ranges {
        for &(c, d) in with {
            let (x, y) = (a.max(c), b.min(d));
            if x < y {
                out.push((x, y));
            }
        }
    }
    out
}

/// Sorted, merged ranges.
fn normalize(mut ranges: Vec<(u64, u64)>) -> Vec<(u64, u64)> {
    ranges.retain(|(a, b)| a < b);
    ranges.sort();
    let mut out: Vec<(u64, u64)> = Vec::new();
    for (a, b) in ranges {
        match out.last_mut() {
            Some(last) if a <= last.1 => last.1 = last.1.max(b),
            _ => out.push((a, b)),
        }
    }
    out
}

fn samples(ms: u64) -> u64 {
    ms * PER_MS
}

/// The reel for a new stream: meeting sample ranges in the order they are fed. Up to eight known
/// voices, the most recently heard first, each with up to 8 s of stretches where only it spoke
/// (newest first, at least 1 s each, outside the tail), ordered by `call-N`; then the last 20 s
/// of audio before `settled_ms`, gaps skipped. The tail ends exactly at the settled position, so
/// the live audio that follows continues it.
pub fn build_reel(turns: &[Turn], settled_ms: u64, reader: &TrackReader) -> Vec<(u64, u64)> {
    let settled = samples(settled_ms);
    let audio = audio_spans(reader, settled);

    // The tail, walking back from the settled position.
    let mut tail = Vec::new();
    let mut left = samples(REEL_TAIL_MS);
    for &(a, b) in audio.iter().rev() {
        if left == 0 {
            break;
        }
        let from = a.max(b.saturating_sub(left));
        tail.push((from, b));
        left -= b - from;
    }
    tail.reverse();
    let tail_start = tail.first().map_or(settled, |t| t.0);

    // The known voices, the most recently heard first.
    let mut last_heard: HashMap<&str, u64> = HashMap::new();
    for t in turns {
        let heard = last_heard.entry(t.speaker.as_str()).or_insert(0);
        *heard = (*heard).max(t.end);
    }
    let mut voices: Vec<(&str, u64)> = last_heard.into_iter().collect();
    voices.sort_by(|a, b| {
        b.1.cmp(&a.1)
            .then_with(|| call_number(a.0).cmp(&call_number(b.0)))
    });
    voices.truncate(REEL_SPEAKERS);

    let mut pieces: Vec<(u64, Vec<(u64, u64)>)> = Vec::new();
    for (voice, _) in voices {
        let own = normalize(
            turns
                .iter()
                .filter(|t| t.speaker == voice)
                .map(|t| (samples(t.start), samples(t.end)))
                .collect(),
        );
        let others = normalize(
            turns
                .iter()
                .filter(|t| t.speaker != voice)
                .map(|t| (samples(t.start), samples(t.end)))
                .collect(),
        );
        let solo = subtract(&own, &others);
        // Real audio only, before the tail.
        let solo = intersect(&solo, &audio);
        let solo = subtract(&solo, &[(tail_start, u64::MAX)]);
        let mut chosen = Vec::new();
        let mut budget = samples(REEL_PER_SPEAKER_MS);
        for &(a, b) in solo.iter().rev() {
            if b - a < samples(REEL_MIN_STRETCH_MS) {
                continue;
            }
            if budget < samples(REEL_MIN_STRETCH_MS) {
                break;
            }
            // The newest part of a stretch longer than what is left.
            let from = a.max(b - budget.min(b - a));
            chosen.push((from, b));
            budget -= b - from;
        }
        chosen.reverse();
        if !chosen.is_empty() {
            pieces.push((call_number(voice).unwrap_or(u64::MAX), chosen));
        }
    }
    pieces.sort_by_key(|(n, _)| *n);
    let mut reel: Vec<(u64, u64)> = pieces.into_iter().flat_map(|(_, p)| p).collect();
    reel.extend(tail);
    reel
}

/// Total overlap of two lists of ranges.
fn overlap(a: &[(u64, u64)], b: &[(u64, u64)]) -> u64 {
    a.iter()
        .flat_map(|&(x, y)| {
            b.iter()
                .map(move |&(c, d)| y.min(d).saturating_sub(x.max(c)))
        })
        .sum()
}

/// Which stored id each of a new stream's labels is, from the meeting ranges (samples) each label
/// spoke in the reel and the stored turns (ms). The largest overlap pairs first, as long as it is
/// at least 0.5 s and 30 % of the label's reel speech; each label and each id is used once.
/// Labels left out are new voices.
pub fn match_labels(
    reel: &HashMap<usize, Vec<(u64, u64)>>,
    stored: &[Turn],
) -> HashMap<usize, String> {
    let mut ids: Vec<&str> = stored.iter().map(|t| t.speaker.as_str()).collect();
    ids.sort_by_key(|id| (call_number(id), id.to_string()));
    ids.dedup();
    let mut pairs: Vec<(u64, usize, &str)> = Vec::new();
    for (&label, ranges) in reel {
        let ranges = normalize(ranges.clone());
        let speech: u64 = ranges.iter().map(|(a, b)| b - a).sum();
        for &id in &ids {
            let turns: Vec<(u64, u64)> = normalize(
                stored
                    .iter()
                    .filter(|t| t.speaker == id)
                    .map(|t| (samples(t.start), samples(t.end)))
                    .collect(),
            );
            let shared = overlap(&ranges, &turns);
            if shared >= samples(MATCH_MIN_MS) && shared as f64 >= MATCH_MIN_SHARE * speech as f64 {
                pairs.push((shared, label, id));
            }
        }
    }
    pairs.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then(a.1.cmp(&b.1))
            .then_with(|| call_number(a.2).cmp(&call_number(b.2)))
    });
    let mut used_labels = HashSet::new();
    let mut used_ids = HashSet::new();
    let mut matched = HashMap::new();
    for (_, label, id) in pairs {
        if used_labels.contains(&label) || used_ids.contains(id) {
            continue;
        }
        used_labels.insert(label);
        used_ids.insert(id);
        matched.insert(label, id.to_owned());
    }
    matched
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    use voice_audio::SegmentWriter;
    use voice_recorder::timeline::SegmentRecord;

    fn turn(speaker: &str, start: u64, end: u64) -> Turn {
        Turn {
            speaker: speaker.into(),
            start,
            end,
        }
    }

    /// A call track with audio over each `(start ms, end ms)`.
    fn reader(dir: &std::path::Path, spans: &[(u64, u64)]) -> TrackReader {
        let mut segments = Vec::new();
        for (i, &(start, end)) in spans.iter().enumerate() {
            let seq = i as u64 + 1;
            let file = voice_recorder::meeting::segment_file("call", seq);
            let path = dir.join(&file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            let mut w = SegmentWriter::create(&path).unwrap();
            w.append(&vec![100i16; ((end - start) * 16) as usize])
                .unwrap();
            let samples = w.close().unwrap();
            segments.push(SegmentRecord {
                track: "call".into(),
                seq,
                t: start,
                file,
                ended: Some(samples),
            });
        }
        TrackReader::new(dir, "call", &segments)
    }

    fn ms(ranges: &[(u64, u64)]) -> Vec<(u64, u64)> {
        ranges.iter().map(|&(a, b)| (a / 16, b / 16)).collect()
    }

    #[test]
    fn the_reel_takes_solo_stretches_newest_first_by_number_then_the_tail() {
        let tmp = TempDir::new("reel");
        let reader = reader(tmp.path(), &[(0, 120_000)]);
        let turns = vec![
            turn("call-2", 0, 5_000),
            // call-1 overlaps call-2 from 4 s to 5 s: not solo.
            turn("call-1", 4_000, 12_000),
            turn("call-2", 13_000, 13_500), // too short
            turn("call-2", 20_000, 30_000),
            turn("call-1", 40_000, 44_000),
            turn("call-1", 80_000, 100_000), // inside the tail, from 80 s
        ];
        let reel = build_reel(&turns, 100_000, &reader);
        assert_eq!(
            ms(&reel),
            vec![
                // call-1, oldest of its pieces first: 5-12 s cut to its newest 4 s, then 40-44 s.
                (8_000, 12_000),
                (40_000, 44_000),
                // call-2: 8 s from 20-30 s.
                (22_000, 30_000),
                // The tail: 80 s to 100 s.
                (80_000, 100_000),
            ],
        );
        // call-1's 60-80 s, outside the tail, is its newest stretch: it comes first.
        let turns = vec![
            turn("call-1", 60_000, 100_000),
            turn("call-1", 10_000, 15_000),
        ];
        assert_eq!(
            ms(&build_reel(&turns, 100_000, &reader)),
            vec![(72_000, 80_000), (80_000, 100_000)]
        );
    }

    #[test]
    fn the_reel_skips_gaps() {
        let tmp = TempDir::new("reel-gaps");
        // Audio 0-10 s and 25-35 s; settled at 35 s.
        let reader = reader(tmp.path(), &[(0, 10_000), (25_000, 35_000)]);
        let turns = vec![turn("call-1", 0, 35_000)];
        let reel = build_reel(&turns, 35_000, &reader);
        // The tail takes 10 s from 25-35 s and 10 s from 0-10 s: nothing is left for a solo piece.
        assert_eq!(ms(&reel), vec![(0, 10_000), (25_000, 35_000)]);
        let reel = build_reel(&turns, 30_000, &reader);
        assert_eq!(ms(&reel), vec![(0, 10_000), (25_000, 30_000)]);
        assert!(build_reel(&[], 0, &reader).is_empty());
    }

    #[test]
    fn at_most_eight_voices_the_most_recent() {
        let tmp = TempDir::new("reel-eight");
        let reader = reader(tmp.path(), &[(0, 200_000)]);
        let turns: Vec<Turn> = (1..=10)
            .map(|n| turn(&format!("call-{n}"), n * 10_000, n * 10_000 + 2_000))
            .collect();
        let reel = build_reel(&turns, 200_000, &reader);
        // call-3 to call-10, by number, then the tail.
        assert_eq!(reel.len(), 9);
        assert_eq!(ms(&reel)[0], (30_000, 32_000));
        assert_eq!(ms(&reel)[7], (100_000, 102_000));
    }

    fn samples_of(ranges: &[(u64, u64)]) -> Vec<(u64, u64)> {
        ranges.iter().map(|&(a, b)| (a * 16, b * 16)).collect()
    }

    #[test]
    fn labels_match_ids_whatever_the_stream_calls_them() {
        let stored = vec![
            turn("call-1", 0, 4_000),
            turn("call-2", 5_000, 9_000),
            turn("call-3", 10_000, 14_000),
        ];
        // The new stream calls call-3 "0", call-1 "1" and call-2 "2".
        let reel: HashMap<usize, Vec<(u64, u64)>> = [
            (0, samples_of(&[(10_200, 13_900)])),
            (1, samples_of(&[(100, 3_800)])),
            (2, samples_of(&[(5_300, 8_800)])),
        ]
        .into();
        let matched = match_labels(&reel, &stored);
        assert_eq!(matched[&0], "call-3");
        assert_eq!(matched[&1], "call-1");
        assert_eq!(matched[&2], "call-2");
    }

    #[test]
    fn a_new_voice_and_a_small_overlap_stay_unmatched() {
        let stored = vec![turn("call-1", 0, 4_000), turn("call-2", 5_000, 9_000)];
        let reel: HashMap<usize, Vec<(u64, u64)>> = [
            // Mostly call-1.
            (3, samples_of(&[(0, 4_000)])),
            // 400 ms of call-2 is under 500 ms.
            (4, samples_of(&[(8_600, 9_000)])),
            // 1 s of call-2, but out of 5 s of speech elsewhere: under 30 %.
            (5, samples_of(&[(5_000, 6_000), (20_000, 25_000)])),
        ]
        .into();
        let matched = match_labels(&reel, &stored);
        assert_eq!(matched.len(), 1);
        assert_eq!(matched[&3], "call-1");
    }

    #[test]
    fn each_id_goes_to_one_label_the_largest_overlap_first() {
        let stored = vec![turn("call-1", 0, 10_000)];
        let reel: HashMap<usize, Vec<(u64, u64)>> = [
            (0, samples_of(&[(0, 3_000)])),
            (1, samples_of(&[(3_000, 9_000)])),
        ]
        .into();
        let matched = match_labels(&reel, &stored);
        assert_eq!(matched.len(), 1);
        assert_eq!(matched[&1], "call-1");
        // A tie goes to the lower label.
        let reel: HashMap<usize, Vec<(u64, u64)>> = [
            (2, samples_of(&[(0, 3_000)])),
            (1, samples_of(&[(5_000, 8_000)])),
        ]
        .into();
        assert_eq!(match_labels(&reel, &stored)[&1], "call-1");
    }

    #[test]
    fn a_voice_silent_in_the_tail_is_matched_through_its_reel_piece() {
        use crate::speakers::clock::StreamClock;
        let tmp = TempDir::new("reel-absent");
        let reader = reader(tmp.path(), &[(0, 60_000)]);
        // call-1 spoke only at the start; the tail, 40-60 s, is all call-2.
        let stored = vec![turn("call-1", 0, 5_000), turn("call-2", 10_000, 60_000)];
        let reel = build_reel(&stored, 60_000, &reader);
        assert_eq!(
            ms(&reel),
            vec![(0, 5_000), (32_000, 40_000), (40_000, 60_000)]
        );
        // The new stream hears the reel in that order and calls call-1 "6", call-2 "1".
        let mut clock = StreamClock::new();
        for &(a, b) in &reel {
            clock.append(a, b - a);
        }
        let first = 5_000 * 16;
        let heard: HashMap<usize, Vec<(u64, u64)>> = [
            (6, clock.split(0, first)),
            (1, clock.split(first, clock.sent())),
        ]
        .into();
        let matched = match_labels(&heard, &stored);
        assert_eq!(matched[&6], "call-1");
        assert_eq!(matched[&1], "call-2");
    }

    #[test]
    fn range_helpers() {
        assert_eq!(
            subtract(&[(0, 10)], &[(2, 3), (5, 7)]),
            vec![(0, 2), (3, 5), (7, 10)]
        );
        assert_eq!(subtract(&[(0, 10)], &[(0, 10)]), vec![]);
        assert_eq!(intersect(&[(0, 10)], &[(5, 20)]), vec![(5, 10)]);
        assert_eq!(normalize(vec![(5, 8), (0, 6), (9, 9)]), vec![(0, 8)]);
        assert_eq!(overlap(&[(0, 10)], &[(5, 20), (8, 9)]), 6);
    }
}
