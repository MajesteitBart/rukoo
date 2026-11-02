//! Who said which words: stored speaker turns applied to a window's recognized words, speaker
//! cuts for the window boundary, and passages from Mistral's labelled segments.
//!
//! The rules start from Ownkey's live path (`meetings/segmentation.py:58-68`, `:91-122`): a word
//! takes a speaker when exactly one speaker's turns overlap it, and a new passage starts at every
//! speaker change or a 0.9 s pause. Voice adds two rules. When several speakers overlap a word, a
//! clear majority takes it (`MAJORITY_RULE`). A run of words without a speaker that lasts under
//! 0.6 s, with the same speaker on both sides, takes that speaker, so a backchannel fragment
//! doesn't split a sentence.
//!
//! Turn times are meeting milliseconds; word times are meeting seconds, as the recognizer's.

use crate::segmentation::{draft, seconds_to_ms, words, Draft, Token, PASSAGE_PAUSE_SECONDS, RATE};
use crate::transcript::StoredSegment;

/// A run of words without a speaker, shorter than this, between two words of one speaker takes
/// that speaker.
const BRIDGE_MS: f64 = 600.0;
/// Only a hand-over with a gap of at most this many ms suggests a cut.
const CUT_GAP_MS: u64 = 2_000;
/// Fallback rule (d): when several speakers overlap a word, the one whose overlap is at least
/// twice the next and at least half the word takes it. On because the AMI test
/// (`tests/speakers_ami.rs`, real Nemotron worker, oracle words) scored 87.5 % of transcript time
/// with rules (a) to (c) alone and 92.1 % with it, the same in repeated runs.
const MAJORITY_RULE: bool = true;

/// One speaker's turn in meeting milliseconds.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Turn {
    pub speaker: String,
    pub start: u64,
    pub end: u64,
}

/// Where a window that starts at meeting sample `window_start` may be cut because one voice
/// hands over to another: in samples from the window start. Only a change between two different
/// speakers with a gap of 0 to 2 s, and no third turn over its midpoint, counts. A port of
/// Ownkey's `turn_boundaries`.
pub fn turn_cuts(turns: &[Turn], window_start: u64) -> Vec<usize> {
    let mut ordered: Vec<&Turn> = turns.iter().collect();
    ordered.sort_by_key(|t| t.start);
    let mut cuts = Vec::new();
    for pair in ordered.windows(2) {
        let (before, after) = (pair[0], pair[1]);
        if before.speaker == after.speaker
            || after.start < before.end
            || after.start - before.end > CUT_GAP_MS
        {
            continue;
        }
        // Twice the midpoint in ms, to stay in integers.
        let twice = before.end + after.start;
        if ordered
            .iter()
            .any(|s| 2 * s.start < twice && twice < 2 * s.end)
        {
            continue;
        }
        let at = twice * (RATE as u64 / 1000) / 2;
        if let Some(cut) = at.checked_sub(window_start) {
            cuts.push(cut as usize);
        }
    }
    cuts
}

/// The distinct speakers whose turns overlap `[start, end)` in ms, with how much each overlaps.
fn overlapping(turns: &[Turn], start: f64, end: f64) -> Vec<(String, f64)> {
    let mut found: Vec<(String, f64)> = Vec::new();
    for t in turns {
        let (a, b) = ((t.start as f64).max(start), (t.end as f64).min(end));
        if (t.start as f64) < end && (t.end as f64) > start {
            let share = (b - a).max(0.0);
            match found.iter_mut().find(|(s, _)| *s == t.speaker) {
                Some((_, total)) => *total += share,
                None => found.push((t.speaker.clone(), share)),
            }
        }
    }
    found
}

/// The speaker of the span `[start, end)` in ms: the only one overlapping it, or with rule (d) a
/// clear majority.
fn span_speaker(turns: &[Turn], start: f64, end: f64, majority: bool) -> Option<String> {
    let mut found = overlapping(turns, start, end);
    if found.len() == 1 {
        return found.pop().map(|(s, _)| s);
    }
    if majority && found.len() > 1 {
        found.sort_by(|a, b| b.1.total_cmp(&a.1));
        let (best, next) = (found[0].1, found[1].1);
        if best >= 2.0 * next && best >= (end - start) / 2.0 {
            return Some(found.swap_remove(0).0);
        }
    }
    None
}

/// The speaker of each word of `owned` (see the module docs for the rules).
pub fn word_speakers(owned: &[Token], turns: &[Turn]) -> Vec<Option<String>> {
    let spans: Vec<(f64, f64)> = words(owned)
        .iter()
        .map(|w| (w[0].start * 1000.0, w[w.len() - 1].end * 1000.0))
        .collect();
    let mut speakers: Vec<Option<String>> = spans
        .iter()
        .map(|&(at, until)| span_speaker(turns, at, until, MAJORITY_RULE))
        .collect();
    // (c): bridge a short run without a speaker between two words of the same speaker.
    let mut i = 0;
    while i < speakers.len() {
        if speakers[i].is_some() {
            i += 1;
            continue;
        }
        let mut j = i;
        while j < speakers.len() && speakers[j].is_none() {
            j += 1;
        }
        if i > 0 && j < speakers.len() && speakers[i - 1] == speakers[j] {
            let length = spans[j - 1].1 - spans[i].0;
            if length < BRIDGE_MS {
                let speaker = speakers[j].clone();
                for s in &mut speakers[i..j] {
                    *s = speaker.clone();
                }
            }
        }
        i = j;
    }
    speakers
}

/// Groups a window's owned words into passages, as `timed_passages` does, and also starts a new
/// passage where the speaker changes. Each draft carries its words' speaker.
pub fn speaker_passages(owned: &[Token], turns: &[Turn]) -> Vec<Draft> {
    let speakers = word_speakers(owned, turns);
    let mut passages: Vec<(f64, f64, Vec<Token>, Option<String>)> = Vec::new();
    for (word, speaker) in words(owned).into_iter().zip(speakers) {
        let (at, until) = (word[0].start, word[word.len() - 1].end);
        match passages.last_mut() {
            Some(last) if last.3 == speaker && at - last.1 < PASSAGE_PAUSE_SECONDS => {
                last.1 = last.1.max(until);
                last.2.extend_from_slice(word);
            }
            _ => passages.push((at.max(0.0), until, word.to_vec(), speaker)),
        }
    }
    passages
        .into_iter()
        .filter_map(|(start, end, tokens, speaker)| {
            let text: String = tokens.iter().map(|t| t.text.as_str()).collect();
            let mut d = draft(seconds_to_ms(start), seconds_to_ms(end), &text, tokens)?;
            d.speaker = speaker;
            Some(d)
        })
        .collect()
}

/// The speaker of a whole window, for recognizers that give text without timings: the only
/// speaker whose turns overlap it, else none.
pub fn window_speaker(turns: &[Turn], start_ms: u64, end_ms: u64) -> Option<String> {
    span_speaker(turns, start_ms as f64, end_ms as f64, false)
}

/// The speaker a stored passage without one can get later: the only speaker whose turns overlap
/// it, else none.
pub fn passage_speaker(turns: &[Turn], start_ms: u64, end_ms: u64) -> Option<String> {
    span_speaker(turns, start_ms as f64, end_ms as f64, false)
}

/// Passages from the segments Mistral's realtime stream returned for one window: one passage per
/// run of the same speaker, with segment times clamped to the window `[start_ms, end_ms]`.
/// `speaker_of` gives a segment's speaker id, or `None`. Labelled segments are whole phrases and
/// join with a space; unlabelled ones are text deltas that carry their own spacing.
pub fn segment_passages(
    segments: &[StoredSegment],
    start_ms: u64,
    end_ms: u64,
    speaker_of: impl Fn(&StoredSegment) -> Option<String>,
) -> Vec<Draft> {
    let mut runs: Vec<(u64, u64, String, Option<String>)> = Vec::new();
    for segment in segments {
        let speaker = speaker_of(segment);
        let a = segment.start.clamp(start_ms, end_ms);
        let b = segment.end.clamp(a, end_ms);
        match runs.last_mut() {
            Some(run) if run.3 == speaker => {
                if segment.label.is_some()
                    && !run.2.ends_with(char::is_whitespace)
                    && !segment.text.starts_with(char::is_whitespace)
                {
                    run.2.push(' ');
                }
                run.2.push_str(&segment.text);
                run.0 = run.0.min(a);
                run.1 = run.1.max(b);
            }
            _ => runs.push((a, b, segment.text.clone(), speaker)),
        }
    }
    runs.into_iter()
        .filter_map(|(a, b, text, speaker)| {
            let mut d = draft(a, b, &text, Vec::new())?;
            d.speaker = speaker;
            Some(d)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::segmentation::owned_tokens;
    use voice_protocol::Track;

    fn turn(speaker: &str, start: u64, end: u64) -> Turn {
        Turn {
            speaker: speaker.into(),
            start,
            end,
        }
    }

    fn tokens(list: &[(&str, f64, f64)]) -> Vec<Token> {
        list.iter()
            .map(|&(text, start, end)| Token {
                text: text.into(),
                start,
                end,
            })
            .collect()
    }

    #[test]
    fn only_exclusive_speaker_changes_suggest_a_cut() {
        let mut turns = vec![turn("a", 0, 3000), turn("b", 3200, 5000)];
        assert_eq!(turn_cuts(&turns, 0), vec![49_600]);
        // Relative to a window that starts at 1 s; one before the window is dropped.
        assert_eq!(turn_cuts(&turns, 16_000), vec![33_600]);
        assert_eq!(turn_cuts(&turns, 60_000), Vec::<usize>::new());
        turns.push(turn("c", 2000, 4000));
        assert_eq!(turn_cuts(&turns, 0), Vec::<usize>::new());
        // The same speaker twice, an overlap and a gap over 2 s cut nothing.
        assert!(turn_cuts(&[turn("a", 0, 1000), turn("a", 1200, 2000)], 0).is_empty());
        assert!(turn_cuts(&[turn("a", 0, 1000), turn("b", 900, 2000)], 0).is_empty());
        assert!(turn_cuts(&[turn("a", 0, 1000), turn("b", 3100, 4000)], 0).is_empty());
        assert_eq!(
            turn_cuts(&[turn("a", 0, 1000), turn("b", 1000, 2000)], 0),
            vec![16_000],
            "a hand-over without a gap"
        );
    }

    #[test]
    fn a_word_takes_a_speaker_only_when_one_overlaps_it() {
        let turns = vec![turn("call-1", 0, 2000), turn("call-2", 1500, 4000)];
        let owned = tokens(&[
            (" one", 0.2, 0.5),
            (" two", 1.6, 1.9),
            (" three", 2.5, 2.8),
            (" four", 4.5, 4.8),
        ]);
        assert_eq!(
            word_speakers(&owned, &turns),
            vec![Some("call-1".into()), None, Some("call-2".into()), None]
        );
        // Two turns of one speaker over a word are still one speaker.
        let split = vec![turn("call-1", 0, 1000), turn("call-1", 1000, 2000)];
        assert_eq!(
            word_speakers(&tokens(&[(" a", 0.8, 1.2)]), &split),
            vec![Some("call-1".into())]
        );
    }

    #[test]
    fn a_word_split_into_pieces_is_judged_whole() {
        // Ownkey's test_speaker_event_cannot_split_a_subword_group.
        let turns = vec![turn("a", 0, 300), turn("b", 300, 1000)];
        let owned = owned_tokens(
            &[" hel".into(), "lo".into()],
            &[0.1, 0.3],
            &[0.2, 0.2],
            0.0,
            0.0,
            1.0,
        );
        let passages = speaker_passages(&owned, &turns);
        assert_eq!(passages.len(), 1);
        assert_eq!(passages[0].text, "hello");
        assert_eq!(passages[0].speaker, None);
    }

    #[test]
    fn a_short_run_without_a_speaker_is_bridged() {
        let turns = vec![
            turn("call-1", 0, 3000),
            turn("call-2", 1150, 1450),
            turn("call-3", 5000, 6000),
        ];
        let owned = tokens(&[
            (" so", 0.5, 0.9),
            (" yeah", 1.1, 1.3),
            (" right", 1.3, 1.5),
            (" then", 2.0, 2.4),
        ]);
        let speakers = word_speakers(&owned, &turns);
        assert!(speakers.iter().all(|s| s.as_deref() == Some("call-1")));
        // Longer than 0.6 s, or with another speaker on one side: not bridged.
        let long = tokens(&[
            (" so", 0.5, 0.9),
            (" yeah", 1.1, 1.3),
            (" right", 1.3, 1.8),
            (" then", 2.0, 2.4),
        ]);
        let turns = vec![turn("call-1", 0, 3000), turn("call-2", 1150, 1750)];
        assert_eq!(word_speakers(&long, &turns)[1], None);
        let edge = tokens(&[(" yeah", 1.1, 1.3), (" then", 2.0, 2.4)]);
        assert_eq!(
            word_speakers(&edge, &turns)[0],
            None,
            "no speaker before it"
        );
    }

    #[test]
    fn passages_split_at_a_speaker_change_and_at_a_pause() {
        let turns = vec![turn("call-1", 0, 2100), turn("call-2", 2300, 9000)];
        let owned = tokens(&[
            (" Hi", 0.2, 0.5),
            (" all.", 0.6, 1.9),
            (" Hello", 2.4, 2.8),
            (" there.", 2.9, 3.2),
            (" Later", 4.5, 4.9),
        ]);
        let found: Vec<(u64, u64, String, Option<String>)> = speaker_passages(&owned, &turns)
            .into_iter()
            .map(|d| (d.start, d.end, d.text, d.speaker))
            .collect();
        assert_eq!(
            found,
            vec![
                (200, 1900, "Hi all.".into(), Some("call-1".into())),
                (2400, 3200, "Hello there.".into(), Some("call-2".into())),
                (4500, 4900, "Later".into(), Some("call-2".into())),
            ]
        );
    }

    #[test]
    fn a_window_or_passage_gets_a_speaker_only_when_one_overlaps_it() {
        let turns = vec![turn("call-1", 0, 4079), turn("call-2", 4771, 8000)];
        assert_eq!(window_speaker(&turns, 0, 4500).as_deref(), Some("call-1"));
        assert_eq!(window_speaker(&turns, 0, 6000), None);
        assert_eq!(window_speaker(&turns, 8100, 9000), None);
        assert_eq!(
            passage_speaker(&turns, 5000, 7000).as_deref(),
            Some("call-2")
        );
        // Touching isn't overlapping.
        assert_eq!(
            passage_speaker(&turns, 4079, 4771),
            None,
            "the gap between them"
        );
    }

    #[test]
    fn the_majority_rule_needs_a_clear_winner() {
        let turns = vec![turn("a", 0, 1900), turn("b", 1800, 4000)];
        assert_eq!(
            span_speaker(&turns, 1000.0, 2000.0, true).as_deref(),
            Some("a")
        );
        assert_eq!(span_speaker(&turns, 1600.0, 2000.0, true), None);
        assert_eq!(span_speaker(&turns, 1000.0, 2000.0, false), None);
    }

    fn segment(n: u64, label: Option<&str>, text: &str, start: u64, end: u64) -> StoredSegment {
        StoredSegment {
            track: Track::Call,
            epoch: 1,
            n,
            label: label.map(str::to_owned),
            text: text.into(),
            start,
            end,
            timed: false,
        }
    }

    #[test]
    fn segments_become_one_passage_per_run_of_a_speaker() {
        let segments = vec![
            segment(0, Some("s1"), "Good morning.", 900, 2000),
            segment(1, Some("s1"), "Shall we start?", 2000, 3000),
            segment(2, Some("s2"), "Yes.", 3100, 3400),
            segment(3, None, "Hmm", 3500, 6200),
        ];
        let found: Vec<(u64, u64, String, Option<String>)> =
            segment_passages(&segments, 1000, 6000, |s| {
                s.label.as_ref().map(|l| format!("call-{}", &l[1..]))
            })
            .into_iter()
            .map(|d| (d.start, d.end, d.text, d.speaker))
            .collect();
        assert_eq!(
            found,
            vec![
                (
                    1000,
                    3000,
                    "Good morning. Shall we start?".into(),
                    Some("call-1".into())
                ),
                (3100, 3400, "Yes.".into(), Some("call-2".into())),
                (3500, 6000, "Hmm".into(), None),
            ]
        );
        // Deltas carry their own spacing.
        let deltas = vec![
            segment(0, None, " Hel", 0, 300),
            segment(1, None, "lo there", 300, 900),
        ];
        let passages = segment_passages(&deltas, 0, 1000, |_| None);
        assert_eq!(passages.len(), 1);
        assert_eq!(passages[0].text, "Hello there");
    }
}
