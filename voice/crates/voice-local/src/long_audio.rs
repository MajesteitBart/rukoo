//! Long dictation, ported from Ownkey (`local_transcription.py:189-234`, `meetings/segmentation.py`).
//!
//! Orukeet decodes a long buffer in one go, but Ownkey cuts anything over 15 s at pauses and decodes
//! it window by window, each with a little audio on both sides for context. A word belongs to the
//! window that holds its middle, so a word that two windows both hear is kept once.

use crate::protocol::Failure;

pub const RATE: usize = 16_000;
/// Untimed audio longer than this is split (`local_transcription.py:189-190`).
pub const SPLIT_ABOVE: usize = 15 * RATE;

/// Audio handed to the boundary search per step.
const WINDOW: usize = 28 * RATE;
/// Energy is measured in 50 ms frames.
const FRAME: usize = 800;
/// No window owns more than 27 s.
const CORE_LIMIT: usize = 27 * RATE;
/// Audio decoded with a window but owned by its neighbours: 600 ms before, 200 ms after.
const LEFT_CONTEXT: usize = 9_600;
const RIGHT_CONTEXT: usize = 3_200;
/// Quiet needed for a cut: 800 ms, or 300 ms once the window is 12 s long.
const LONG_PAUSE: usize = 12_800;
const SHORT_PAUSE: usize = 4_800;
const SHORT_PAUSE_AFTER: usize = 12 * RATE;
/// Five seconds without speech end a window, so silence doesn't fill one up.
const SILENCE: usize = 5 * RATE;
/// A forced cut picks the quietest frame in the last 8 s before the limit.
const LIMIT_SEARCH: usize = 8 * RATE;
/// The quiet threshold looks back at most 200 frames (10 s).
const HISTORY_FRAMES: usize = 200;
const MIN_THRESHOLD: f64 = 60.0;

/// What a decode returns, with times in seconds from the start of the decoded audio.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Recognized {
    pub text: String,
    pub tokens: Vec<String>,
    pub timestamps: Vec<f64>,
    pub durations: Vec<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    Pause,
    Silence,
    Limit,
    Tail,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Boundary {
    pub end: usize,
    pub reason: Reason,
}

/// Where the next window ends inside `samples`, `meetings/segmentation.py` `next_boundary` without
/// speaker cuts. `None` means more audio is needed first; with `last` set there is always an answer.
pub fn next_boundary(samples: &[i16], last: bool) -> Option<Boundary> {
    let total = samples.len();
    if total == 0 {
        return None;
    }
    let energy: Vec<f64> = samples
        .chunks_exact(FRAME)
        .map(|frame| frame.iter().map(|&s| f64::from(s).abs()).sum::<f64>() / FRAME as f64)
        .collect();

    let mut boundary = None;
    let mut run = 0;
    let mut heard = false;
    for i in 0..energy.len().min(CORE_LIMIT / FRAME) {
        let history = &energy[(i + 1).saturating_sub(HISTORY_FRAMES)..=i];
        let quiet = energy[i] < quiet_threshold(history);
        heard |= !quiet;
        run = if quiet { run + 1 } else { 0 };
        let elapsed = (i + 1) * FRAME;
        let needed = if elapsed >= SHORT_PAUSE_AFTER {
            SHORT_PAUSE
        } else {
            LONG_PAUSE
        };
        if heard && run * FRAME >= needed {
            // Cut in the middle of the quiet stretch.
            boundary = Some(Boundary {
                end: elapsed - run * FRAME / 2,
                reason: Reason::Pause,
            });
            break;
        }
        if !heard && elapsed >= SILENCE {
            boundary = Some(Boundary {
                end: elapsed,
                reason: Reason::Silence,
            });
            break;
        }
    }
    if boundary.is_none() && total >= CORE_LIMIT + RIGHT_CONTEXT {
        let low = (CORE_LIMIT - LIMIT_SEARCH) / FRAME;
        let high = CORE_LIMIT / FRAME;
        let quietest = low + first_minimum(&energy[low..high]);
        boundary = Some(Boundary {
            end: quietest * FRAME + FRAME / 2,
            reason: Reason::Limit,
        });
    }
    if boundary.is_none() && last {
        boundary = Some(Boundary {
            end: total.min(CORE_LIMIT),
            reason: Reason::Tail,
        });
    }
    match boundary {
        Some(found) if !last && found.end + RIGHT_CONTEXT > total => None,
        found => found,
    }
}

/// `max(60, 8 % of the 90th percentile of the non-zero frames)`, with numpy's linear interpolation.
fn quiet_threshold(history: &[f64]) -> f64 {
    let mut heard: Vec<f64> = history.iter().copied().filter(|&e| e > 0.0).collect();
    if heard.is_empty() {
        return MIN_THRESHOLD;
    }
    heard.sort_by(f64::total_cmp);
    let rank = 0.9 * (heard.len() - 1) as f64;
    let below = rank.floor() as usize;
    let above = rank.ceil() as usize;
    let percentile = heard[below] + (heard[above] - heard[below]) * (rank - below as f64);
    MIN_THRESHOLD.max(0.08 * percentile)
}

fn first_minimum(values: &[f64]) -> usize {
    let mut best = 0;
    for (i, &value) in values.iter().enumerate() {
        if value < values[best] {
            best = i;
        }
    }
    best
}

/// One step of the split: the window owns `start..end` and is decoded with `left..right`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Window {
    pub left: usize,
    pub start: usize,
    pub end: usize,
    pub right: usize,
}

/// Cuts the whole buffer into windows that cover it exactly once.
pub fn plan_windows(pcm: &[i16]) -> Vec<Window> {
    let mut windows = Vec::new();
    let mut start = 0;
    while start < pcm.len() {
        let core = &pcm[start..(start + WINDOW).min(pcm.len())];
        let last = start + core.len() >= pcm.len();
        // A full 28 s window always has a boundary and so does the last one; the fallback keeps
        // the loop moving if that ever stops being true.
        let length = next_boundary(core, last)
            .map_or(core.len().min(CORE_LIMIT), |boundary| boundary.end)
            .max(1);
        let end = start + length;
        windows.push(Window {
            left: start.saturating_sub(LEFT_CONTEXT),
            start,
            end,
            right: (end + RIGHT_CONTEXT).min(pcm.len()),
        });
        start = end;
    }
    windows
}

/// `np.any(np.abs(samples) > .002)` on float samples.
fn has_speech(pcm: &[i16]) -> bool {
    pcm.iter().any(|&s| f64::from(s).abs() / 32_768.0 > 0.002)
}

/// A recognized piece with absolute times in seconds.
#[derive(Debug, Clone, PartialEq)]
pub struct Token {
    pub piece: String,
    pub at: f64,
    pub until: f64,
}

/// The tokens of whole words whose middle lies in `start..end`, `owned_tokens` in Ownkey.
/// A piece that starts with whitespace starts a word. Times are shifted by `offset`.
pub fn owned_tokens(result: &Recognized, offset: f64, start: f64, end: f64) -> Vec<Token> {
    let mut words: Vec<Vec<Token>> = Vec::new();
    for (i, piece) in result.tokens.iter().enumerate() {
        let at = offset + result.timestamps.get(i).copied().unwrap_or(0.0);
        let until = at + result.durations.get(i).copied().unwrap_or(0.2).max(0.02);
        let starts_word = piece.chars().next().is_some_and(char::is_whitespace);
        if words.is_empty() || starts_word {
            words.push(Vec::new());
        }
        if let Some(word) = words.last_mut() {
            word.push(Token {
                piece: piece.clone(),
                at,
                until,
            });
        }
    }
    words
        .into_iter()
        .filter(|word| {
            let middle = (word[0].at + word[word.len() - 1].until) / 2.0;
            start <= middle && middle < end
        })
        .flatten()
        .collect()
}

/// Decodes long audio window by window and joins the result. Token times are from the start of
/// `pcm`. `decode` gets the audio of one window with its context.
pub fn transcribe<F>(pcm: &[i16], mut decode: F) -> Result<Recognized, Failure>
where
    F: FnMut(&[i16]) -> Result<Recognized, Failure>,
{
    let seconds = |samples: usize| samples as f64 / RATE as f64;
    let mut parts = Vec::new();
    let mut joined = Recognized::default();
    for window in plan_windows(pcm) {
        if !has_speech(&pcm[window.start..window.end]) {
            continue;
        }
        let result = decode(&pcm[window.left..window.right])?;
        let text = if result.tokens.is_empty() {
            result.text.trim().to_owned()
        } else {
            let owned = owned_tokens(
                &result,
                seconds(window.left),
                seconds(window.start),
                seconds(window.end),
            );
            let text = owned
                .iter()
                .map(|token| token.piece.as_str())
                .collect::<String>();
            for token in owned {
                joined.timestamps.push(token.at);
                joined.durations.push(token.until - token.at);
                joined.tokens.push(token.piece);
            }
            text.trim().to_owned()
        };
        if !text.is_empty() {
            parts.push(text);
        }
    }
    joined.text = parts.join(" ");
    Ok(joined)
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOUD: i16 = 8_000;

    /// A 440 Hz tone, loud enough to count as speech.
    fn tone(samples: usize) -> Vec<i16> {
        (0..samples)
            .map(|i| {
                let phase = i as f64 * 440.0 * std::f64::consts::TAU / RATE as f64;
                (phase.sin() * f64::from(LOUD)) as i16
            })
            .collect()
    }

    fn silence(samples: usize) -> Vec<i16> {
        vec![0; samples]
    }

    fn seconds(s: f64) -> usize {
        (s * RATE as f64) as usize
    }

    #[test]
    fn cuts_inside_a_long_pause() {
        let mut audio = tone(seconds(3.0));
        audio.extend(silence(seconds(1.0)));
        audio.extend(tone(seconds(3.0)));
        let boundary = next_boundary(&audio, false).unwrap();
        assert_eq!(boundary.reason, Reason::Pause);
        assert!(
            (seconds(3.0)..seconds(4.0)).contains(&boundary.end),
            "{boundary:?}"
        );
    }

    #[test]
    fn a_short_pause_cuts_only_after_twelve_seconds() {
        let mut audio = tone(seconds(5.0));
        audio.extend(silence(seconds(0.4)));
        audio.extend(tone(seconds(8.0)));
        audio.extend(silence(seconds(0.4)));
        audio.extend(tone(seconds(5.0)));
        let boundary = next_boundary(&audio, false).unwrap();
        assert_eq!(boundary.reason, Reason::Pause);
        assert!(boundary.end > seconds(13.0), "{boundary:?}");
        assert!(boundary.end < seconds(13.8), "{boundary:?}");
    }

    #[test]
    fn five_seconds_of_silence_end_a_window() {
        let boundary = next_boundary(&silence(seconds(6.0)), false).unwrap();
        assert_eq!(
            boundary,
            Boundary {
                end: seconds(5.0),
                reason: Reason::Silence
            }
        );
    }

    #[test]
    fn continuous_speech_is_cut_at_the_limit() {
        let boundary = next_boundary(&tone(WINDOW), false).unwrap();
        assert_eq!(boundary.reason, Reason::Limit);
        assert!(boundary.end > CORE_LIMIT - LIMIT_SEARCH && boundary.end < CORE_LIMIT);
    }

    #[test]
    fn needs_more_audio_unless_it_is_the_last_window() {
        let audio = tone(seconds(4.0));
        assert_eq!(next_boundary(&audio, false), None);
        assert_eq!(
            next_boundary(&audio, true),
            Some(Boundary {
                end: audio.len(),
                reason: Reason::Tail
            })
        );
        // A 300 ms pause after 12 s is cut in its middle, 150 ms before the end, which leaves too
        // little right context until more audio arrives.
        let mut audio = tone(seconds(12.0));
        audio.extend(silence(seconds(0.3)));
        assert_eq!(next_boundary(&audio, false), None);
        assert_eq!(next_boundary(&audio, true).unwrap().reason, Reason::Pause);
    }

    #[test]
    fn threshold_matches_numpy_percentile() {
        // np.percentile([100, 200, 300, 400, 1000], 90) == 760
        let threshold = quiet_threshold(&[0.0, 100.0, 200.0, 300.0, 400.0, 1000.0]);
        assert!((threshold - 0.08 * 760.0).abs() < 1e-9);
        assert_eq!(quiet_threshold(&[0.0, 0.0]), MIN_THRESHOLD);
        assert_eq!(quiet_threshold(&[10.0]), MIN_THRESHOLD);
    }

    #[test]
    fn windows_cover_the_audio_exactly_once() {
        let mut audio = Vec::new();
        for _ in 0..4 {
            audio.extend(tone(seconds(9.0)));
            audio.extend(silence(seconds(0.5)));
        }
        audio.extend(tone(seconds(31.0)));
        audio.extend(silence(seconds(7.0)));
        audio.extend(tone(seconds(2.0)));

        let windows = plan_windows(&audio);
        assert_eq!(windows[0].start, 0);
        assert_eq!(windows.last().unwrap().end, audio.len());
        for pair in windows.windows(2) {
            assert_eq!(pair[0].end, pair[1].start);
        }
        for window in &windows {
            assert!(window.end - window.start <= CORE_LIMIT, "{window:?}");
            assert_eq!(window.left, window.start.saturating_sub(LEFT_CONTEXT));
            assert_eq!(window.right, (window.end + RIGHT_CONTEXT).min(audio.len()));
        }
    }

    fn recognized(pieces: &[(&str, f64, f64)]) -> Recognized {
        Recognized {
            text: pieces.iter().map(|p| p.0).collect(),
            tokens: pieces.iter().map(|p| p.0.to_owned()).collect(),
            timestamps: pieces.iter().map(|p| p.1).collect(),
            durations: pieces.iter().map(|p| p.2).collect(),
        }
    }

    #[test]
    fn a_word_belongs_to_the_window_that_holds_its_middle() {
        let result = recognized(&[
            (" Hel", 0.1, 0.2),
            ("lo", 0.3, 0.2),
            (" big", 0.9, 0.3),
            (" world", 1.6, 0.4),
        ]);
        // Offset 10 s; the window owns 10.0..11.2 s. " big" spans 10.9..11.2, middle 11.05.
        let owned = owned_tokens(&result, 10.0, 10.0, 11.2);
        let pieces: Vec<&str> = owned.iter().map(|t| t.piece.as_str()).collect();
        assert_eq!(pieces, [" Hel", "lo", " big"]);
        assert!((owned[0].at - 10.1).abs() < 1e-9);

        let rest = owned_tokens(&result, 10.0, 11.2, 20.0);
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0].piece, " world");
    }

    #[test]
    fn missing_times_fall_back_like_ownkey() {
        let result = Recognized {
            text: " a b".into(),
            tokens: vec![" a".into(), " b".into()],
            timestamps: vec![1.0],
            durations: vec![0.0],
        };
        let owned = owned_tokens(&result, 0.0, 0.0, 10.0);
        // A zero duration counts as 20 ms; a missing one as 200 ms; a missing timestamp as 0.
        assert!((owned[0].until - 1.02).abs() < 1e-9);
        assert_eq!((owned[1].at, owned[1].until), (0.0, 0.2));
    }

    /// Stands in for Orukeet: every tone burst is one word, timed from the start of the window.
    fn fake_decode(window: &[i16]) -> Result<Recognized, Failure> {
        let mut result = Recognized::default();
        let frame = RATE / 100;
        let mut previous_loud = false;
        for (i, chunk) in window.chunks(frame).enumerate() {
            let loud = chunk.iter().any(|&s| s.unsigned_abs() > 1_000);
            if loud && !previous_loud {
                result.tokens.push(" w".into());
                result.timestamps.push(i as f64 / 100.0);
                result.durations.push(0.3);
            }
            previous_loud = loud;
        }
        result.text = result.tokens.concat();
        Ok(result)
    }

    #[test]
    fn long_audio_keeps_every_word_once_with_absolute_times() {
        // 300 ms words with 400 ms gaps for 40 s, a 6 s silence, then 10 more words.
        let mut audio = Vec::new();
        let mut onsets = Vec::new();
        while audio.len() < seconds(40.0) {
            onsets.push(audio.len() as f64 / RATE as f64);
            audio.extend(tone(seconds(0.3)));
            audio.extend(silence(seconds(0.4)));
        }
        audio.extend(silence(seconds(6.0)));
        for _ in 0..10 {
            onsets.push(audio.len() as f64 / RATE as f64);
            audio.extend(tone(seconds(0.3)));
            audio.extend(silence(seconds(0.4)));
        }

        let mut decoded = 0;
        let result = transcribe(&audio, |window| {
            decoded += 1;
            assert!(window.len() <= LEFT_CONTEXT + CORE_LIMIT + RIGHT_CONTEXT);
            fake_decode(window)
        })
        .unwrap();

        assert_eq!(result.tokens.len(), onsets.len());
        for (at, onset) in result.timestamps.iter().zip(&onsets) {
            assert!((at - onset).abs() < 0.011, "{at} vs {onset}");
        }
        assert_eq!(result.text, vec!["w"; onsets.len()].join(" "));
        assert!(decoded >= 3, "decoded {decoded} windows");
    }

    #[test]
    fn silent_windows_are_not_decoded() {
        let audio = silence(seconds(40.0));
        let result = transcribe(&audio, |_| panic!("silence was decoded")).unwrap();
        assert_eq!(result, Recognized::default());
    }

    #[test]
    fn text_only_results_are_joined_with_spaces() {
        let mut audio = tone(seconds(10.0));
        audio.extend(silence(seconds(1.0)));
        audio.extend(tone(seconds(10.0)));
        let result = transcribe(&audio, |_| {
            Ok(Recognized {
                text: " part ".into(),
                ..Recognized::default()
            })
        })
        .unwrap();
        assert_eq!(result.text, "part part");
        assert!(result.tokens.is_empty());
    }
}
