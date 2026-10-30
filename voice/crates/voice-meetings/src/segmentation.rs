//! Where a window of recorded audio ends, and which recognized words belong to it.
//!
//! A port of Ownkey's live segmentation (`meetings/segmentation.py`): wait for 800 ms of low
//! energy and cut inside it; after 12 s accept 300 ms; never own more than 27 s, cutting at the
//! quietest frame of the last 8 s; 5 s without speech moves on. The threshold uses only the 10 s
//! before each frame, so a window can be decided while the meeting is still recording.
//!
//! Orukeet drops words when one decode window is long or mixes languages, which is why meetings
//! are recognized in windows of at most 27 s plus a little context, not in one go.
//!
//! Positions are in samples at 16 kHz.

/// Samples per second of every stored track.
pub const RATE: usize = 16_000;
/// 50 ms: the unit energy is measured in.
pub const FRAME: usize = 800;
/// The most audio one window owns.
pub const CORE_LIMIT: usize = 27 * RATE;
/// Audio before a window that a timed recognizer hears but doesn't own: 0.6 s.
pub const LEFT_CONTEXT: usize = 9_600;
/// Audio after a window that has to be on disk before the window is cut, and that a timed
/// recognizer hears but doesn't own: 0.2 s.
pub const RIGHT_CONTEXT: usize = 3_200;

/// A window shorter than 0.08 s isn't worth a recognition call.
const MIN_DECODE: usize = 1_280;
/// A window this quiet holds no speech.
const SILENT_DB: f64 = -55.0;
/// The threshold looks back this many frames: 10 s.
const HISTORY_FRAMES: usize = 200;
/// The pause a cut needs: 0.8 s, or 0.3 s once the window is 12 s long.
const PAUSE: usize = 12_800;
const LATE_PAUSE: usize = 4_800;
const LATE_AFTER: usize = 12 * RATE;
/// No speech for 5 s ends a window anyway.
const SILENCE: usize = 5 * RATE;
/// A forced cut looks for the quietest frame in the last 8 s before the limit.
const LIMIT_SEARCH: usize = 8 * RATE;
/// A word ends this long after its start when the recognizer gives no duration.
const DEFAULT_TOKEN_SECONDS: f64 = 0.2;
const MIN_TOKEN_SECONDS: f64 = 0.02;
/// A pause this long inside a window starts a new passage.
const PASSAGE_PAUSE_SECONDS: f64 = 0.9;

/// Why a window ends where it does. Stored with each window in `transcript.db`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    /// A pause in the speech.
    Pause,
    /// 5 s without speech.
    Silence,
    /// The window reached 27 s; it ends at the quietest moment of its last 8 s.
    Limit,
    /// The recording ended.
    Tail,
}

impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::Pause => "pause",
            Reason::Silence => "silence",
            Reason::Limit => "limit",
            Reason::Tail => "tail",
        }
    }
}

/// The end of the next window, relative to its start.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Boundary {
    pub end: usize,
    pub reason: Reason,
}

/// Where the window that starts at `samples[0]` ends, or `None` when that needs more audio.
///
/// `last` says that `samples` runs to the end of the recording, so the rest becomes a window
/// even without a pause. Otherwise a cut also needs [`RIGHT_CONTEXT`] after it.
pub fn next_boundary(samples: &[i16], last: bool) -> Option<Boundary> {
    let total = samples.len();
    if total == 0 {
        return None;
    }
    let energy = frame_energy(samples);
    let mut run = 0;
    let mut heard = false;
    let mut boundary = None;
    for i in 0..energy.len().min(CORE_LIMIT / FRAME) {
        let history = &energy[i.saturating_sub(HISTORY_FRAMES - 1)..=i];
        let quiet = energy[i] < threshold(history);
        heard |= !quiet;
        run = if quiet { run + 1 } else { 0 };
        let elapsed = (i + 1) * FRAME;
        let needed = if elapsed >= LATE_AFTER {
            LATE_PAUSE
        } else {
            PAUSE
        };
        if heard && run * FRAME >= needed {
            // Cut in the middle of the pause.
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
        let (lo, hi) = ((CORE_LIMIT - LIMIT_SEARCH) / FRAME, CORE_LIMIT / FRAME);
        let quietest = energy[lo..hi]
            .iter()
            .enumerate()
            .fold(
                (0, f64::INFINITY),
                |best, (i, &e)| {
                    if e < best.1 {
                        (i, e)
                    } else {
                        best
                    }
                },
            )
            .0;
        boundary = Some(Boundary {
            end: (lo + quietest) * FRAME + FRAME / 2,
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
        Some(b) if !last && b.end + RIGHT_CONTEXT > total => None,
        b => b,
    }
}

/// The mean absolute sample of every whole frame.
fn frame_energy(samples: &[i16]) -> Vec<f64> {
    samples
        .chunks_exact(FRAME)
        .map(|frame| frame.iter().map(|&s| f64::from(s).abs()).sum::<f64>() / FRAME as f64)
        .collect()
}

/// Ownkey's threshold: 8 % of the 90th percentile of the frames that aren't digital silence,
/// but at least 60.
fn threshold(history: &[f64]) -> f64 {
    let mut heard: Vec<f64> = history.iter().copied().filter(|&e| e > 0.0).collect();
    if heard.is_empty() {
        return 60.0;
    }
    heard.sort_by(f64::total_cmp);
    (0.08 * percentile(&heard, 0.9)).max(60.0)
}

/// numpy's default percentile: linear between the two nearest ranks.
fn percentile(sorted: &[f64], q: f64) -> f64 {
    let rank = q * (sorted.len() - 1) as f64;
    let lo = rank.floor() as usize;
    let hi = rank.ceil() as usize;
    sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo as f64)
}

/// Whether a window holds enough sound to send to the recognizer: at least 0.08 s, and louder
/// than -55 dBFS.
pub fn worth_recognizing(core: &[i16]) -> bool {
    core.len() >= MIN_DECODE && rms_db(core) > SILENT_DB
}

/// The level in dBFS; -120 for nothing.
pub fn rms_db(samples: &[i16]) -> f64 {
    if samples.is_empty() {
        return -120.0;
    }
    let power = samples
        .iter()
        .map(|&s| {
            let x = f64::from(s) / 32_768.0;
            x * x
        })
        .sum::<f64>()
        / samples.len() as f64;
    20.0 * power.sqrt().max(1e-6).log10()
}

/// A recognized word piece, with its start and end in seconds of meeting time.
#[derive(Clone, Debug, PartialEq)]
pub struct Token {
    pub text: String,
    pub start: f64,
    pub end: f64,
}

/// The tokens of the words that belong to the window `[start, end)`.
///
/// A piece that starts with whitespace starts a word. A word belongs to the window that holds its
/// midpoint, so a word that two overlapping windows both heard is kept exactly once, and a word
/// someone says twice stays twice. `offset` is the meeting time of the recognized audio's first
/// sample; `timestamps` and `durations` count from there.
pub fn owned_tokens(
    tokens: &[String],
    timestamps: &[f64],
    durations: &[f64],
    offset: f64,
    start: f64,
    end: f64,
) -> Vec<Token> {
    let mut words: Vec<Vec<Token>> = Vec::new();
    for (i, piece) in tokens.iter().enumerate() {
        let at = offset + timestamps.get(i).copied().unwrap_or(0.0);
        let length = durations
            .get(i)
            .copied()
            .unwrap_or(DEFAULT_TOKEN_SECONDS)
            .max(MIN_TOKEN_SECONDS);
        let token = Token {
            text: piece.clone(),
            start: at,
            end: at + length,
        };
        match words.last_mut() {
            Some(word) if !starts_word(piece) => word.push(token),
            _ => words.push(vec![token]),
        }
    }
    words
        .into_iter()
        .filter(|word| {
            let midpoint = (word[0].start + word[word.len() - 1].end) / 2.0;
            start <= midpoint && midpoint < end
        })
        .flatten()
        .collect()
}

fn starts_word(piece: &str) -> bool {
    piece.chars().next().is_some_and(char::is_whitespace)
}

/// A passage before it gets its id: meeting times in milliseconds, and the tokens it was built
/// from, if the recognizer timed them.
#[derive(Clone, Debug, PartialEq)]
pub struct Draft {
    pub start: u64,
    pub end: u64,
    pub text: String,
    pub tokens: Vec<Token>,
}

/// Groups a window's owned tokens into passages: a pause of 0.9 s or more starts a new one.
pub fn timed_passages(owned: &[Token]) -> Vec<Draft> {
    let mut passages: Vec<(f64, f64, Vec<Token>)> = Vec::new();
    let mut words: Vec<&[Token]> = Vec::new();
    let mut from = 0;
    for i in 1..=owned.len() {
        if i == owned.len() || starts_word(&owned[i].text) {
            words.push(&owned[from..i]);
            from = i;
        }
    }
    for word in words.into_iter().filter(|w| !w.is_empty()) {
        let (at, until) = (word[0].start, word[word.len() - 1].end);
        match passages.last_mut() {
            Some(last) if at - last.1 < PASSAGE_PAUSE_SECONDS => {
                last.1 = last.1.max(until);
                last.2.extend_from_slice(word);
            }
            _ => passages.push((at.max(0.0), until, word.to_vec())),
        }
    }
    passages
        .into_iter()
        .filter_map(|(start, end, tokens)| {
            let text: String = tokens.iter().map(|t| t.text.as_str()).collect();
            draft(seconds_to_ms(start), seconds_to_ms(end), &text, tokens)
        })
        .collect()
}

/// Keeps a window's passages inside the window, `[start, end]` in ms. A word belongs to the window
/// that holds its midpoint, but its timing can reach past the window's edges: Orukeet's duration
/// of the last word before a pause runs into the pause. Clamped, the passages of neighbouring
/// windows never overlap.
pub fn within(drafts: &mut [Draft], start: u64, end: u64) {
    for draft in drafts {
        draft.start = draft.start.clamp(start, end);
        draft.end = draft.end.clamp(draft.start, end);
    }
}

/// One passage over the whole window, for recognizers that give text without timings.
pub fn window_passage(text: &str, start: u64, end: u64) -> Option<Draft> {
    draft(start, end, text, Vec::new())
}

fn draft(start: u64, end: u64, text: &str, tokens: Vec<Token>) -> Option<Draft> {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    (!text.is_empty()).then(|| Draft {
        start,
        end: end.max(start),
        text,
        tokens,
    })
}

fn seconds_to_ms(seconds: f64) -> u64 {
    (seconds.max(0.0) * 1000.0).round() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passages_stay_inside_their_window() {
        // From a live run: the window ended at 25.198 s, but the duration of its last word,
        // "yesterday.", ran to 25.588 s, past the start of the next window.
        let owned = owned_tokens(
            &[" yester".into(), "day".into(), ".".into()],
            &[3.2, 3.6, 3.9],
            &[0.4, 0.3, 0.69],
            21.0,
            20.0,
            25.198,
        );
        let mut drafts = timed_passages(&owned);
        assert_eq!((drafts[0].start, drafts[0].end), (24_200, 25_590));
        within(&mut drafts, 20_000, 25_198);
        assert_eq!((drafts[0].start, drafts[0].end), (24_200, 25_198));
        // Context before the window can't pull a passage's start before it either.
        let mut early = vec![Draft {
            start: 19_400,
            end: 20_300,
            text: "so".into(),
            tokens: Vec::new(),
        }];
        within(&mut early, 20_000, 25_198);
        assert_eq!((early[0].start, early[0].end), (20_000, 20_300));
    }

    /// A test signal: (seconds, loud) pieces, loud being a 300 Hz square wave of amplitude 4000.
    fn signal(pieces: &[(f64, bool)]) -> Vec<i16> {
        let mut out = Vec::new();
        for &(seconds, loud) in pieces {
            let n = (seconds * RATE as f64) as usize;
            for i in 0..n {
                let v = if !loud {
                    0
                } else if (i / 27) % 2 == 0 {
                    4000
                } else {
                    -4000
                };
                out.push(v);
            }
        }
        out
    }

    #[test]
    fn cuts_in_the_middle_of_a_pause() {
        let audio = signal(&[(2.0, true), (1.2, false), (2.0, true)]);
        let b = next_boundary(&audio, false).unwrap();
        assert_eq!(b.reason, Reason::Pause);
        // Speech ends at 2.0 s; the 0.8 s pause is complete at 2.8 s; the cut goes at 2.4 s.
        assert_eq!(b.end, 2 * RATE + 400 * 16);
    }

    #[test]
    fn waits_for_the_pause_to_complete_and_for_right_context() {
        let audio = signal(&[(2.0, true), (0.7, false)]);
        assert_eq!(next_boundary(&audio, false), None);
        // The pause is complete at 2.8 s, the cut at 2.4 s, so 2.6 s must be on disk: it is.
        let audio = signal(&[(2.0, true), (0.8, false)]);
        assert_eq!(next_boundary(&audio, false).unwrap().end, 38_400);
    }

    #[test]
    fn a_short_pause_is_enough_after_twelve_seconds() {
        let audio = signal(&[(13.0, true), (0.35, false), (1.0, true)]);
        let b = next_boundary(&audio, false).unwrap();
        assert_eq!(b.reason, Reason::Pause);
        assert!(b.end > 13 * RATE && b.end < 13 * RATE + 6_000, "{b:?}");
    }

    #[test]
    fn five_seconds_without_speech_move_on() {
        let audio = signal(&[(6.0, false)]);
        assert_eq!(
            next_boundary(&audio, false),
            Some(Boundary {
                end: 5 * RATE,
                reason: Reason::Silence
            })
        );
        // Noise below 60 counts as silence too.
        let hum = vec![30i16; 6 * RATE];
        assert_eq!(next_boundary(&hum, false).unwrap().reason, Reason::Silence);
    }

    #[test]
    fn a_long_turn_is_cut_at_its_quietest_moment() {
        let mut audio = signal(&[(28.0, true)]);
        // A softer stretch at 22 s, above the pause threshold but the quietest around.
        for s in &mut audio[22 * RATE..22 * RATE + FRAME] {
            *s /= 4;
        }
        assert_eq!(next_boundary(&audio[..CORE_LIMIT], false), None);
        let b = next_boundary(&audio, false).unwrap();
        assert_eq!(b.reason, Reason::Limit);
        assert_eq!(b.end, 22 * RATE + FRAME / 2);
    }

    #[test]
    fn the_end_of_the_recording_is_a_window_of_its_own() {
        let audio = signal(&[(3.0, true)]);
        assert_eq!(next_boundary(&audio, false), None);
        assert_eq!(
            next_boundary(&audio, true),
            Some(Boundary {
                end: 3 * RATE,
                reason: Reason::Tail
            })
        );
        assert_eq!(next_boundary(&[], true), None);
        // A pause found in the last stretch needs no right context.
        let audio = signal(&[(2.0, true), (0.85, false)]);
        assert_eq!(next_boundary(&audio, true).unwrap().reason, Reason::Pause);
    }

    #[test]
    fn the_threshold_follows_the_speaker() {
        // A quiet speaker at amplitude 400 still has pauses, since 8 % of 400 is below 60.
        let quiet: Vec<i16> = signal(&[(2.0, true), (1.0, false), (1.0, true)])
            .iter()
            .map(|s| s / 10)
            .collect();
        assert_eq!(next_boundary(&quiet, false).unwrap().reason, Reason::Pause);
        assert!((threshold(&[0.0, 0.0]) - 60.0).abs() < f64::EPSILON);
        let loud: Vec<f64> = (1..=10).map(|i| f64::from(i) * 1000.0).collect();
        assert!((threshold(&loud) - 0.08 * 9100.0).abs() < 1e-9);
    }

    #[test]
    fn only_audible_windows_are_recognized() {
        assert!(!worth_recognizing(&[]));
        assert!(!worth_recognizing(&vec![0; 32_000]));
        assert!(!worth_recognizing(&vec![40; 32_000]));
        assert!(!worth_recognizing(&signal(&[(0.05, true)])));
        assert!(worth_recognizing(&signal(&[(0.5, true)])));
        assert!((rms_db(&[32_767, -32_768]) - 0.0).abs() < 0.01);
    }

    fn pieces(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn words_belong_to_the_window_that_holds_their_midpoint() {
        let tokens = pieces(&[" Hel", "lo", " there", " friend"]);
        let stamps = [0.1, 0.3, 0.8, 1.6];
        // Offset 10 s: the words are at 10.1-10.5, 10.8-11.0 and 11.6-11.8.
        let owned = owned_tokens(&tokens, &stamps, &[], 10.0, 10.0, 11.0);
        let texts: Vec<&str> = owned.iter().map(|t| t.text.as_str()).collect();
        assert_eq!(texts, vec![" Hel", "lo", " there"]);
        let owned = owned_tokens(&tokens, &stamps, &[], 10.0, 11.0, 12.0);
        assert_eq!(owned.len(), 1);
        assert_eq!(owned[0].text, " friend");
        // Durations, when given, set the end; tiny ones are 20 ms.
        let owned = owned_tokens(&pieces(&[" a"]), &[0.0], &[0.0], 0.0, 0.0, 1.0);
        assert!((owned[0].end - 0.02).abs() < 1e-9);
    }

    #[test]
    fn a_long_pause_starts_a_new_passage() {
        let tokens = pieces(&[" One", " two", ".", " Three", " four"]);
        let stamps = [0.0, 0.3, 0.45, 2.0, 2.3];
        let owned = owned_tokens(&tokens, &stamps, &[], 60.0, 60.0, 63.0);
        let passages = timed_passages(&owned);
        let found: Vec<(u64, u64, &str, usize)> = passages
            .iter()
            .map(|p| (p.start, p.end, p.text.as_str(), p.tokens.len()))
            .collect();
        assert_eq!(
            found,
            vec![
                (60_000, 60_650, "One two.", 3),
                (62_000, 62_500, "Three four", 2)
            ]
        );
        assert_eq!(passages[1].tokens[0].text, " Three");
    }

    #[test]
    fn text_without_timings_is_one_passage() {
        assert_eq!(
            window_passage("  Let's  move\nthe launch ", 1_000, 4_000),
            Some(Draft {
                start: 1_000,
                end: 4_000,
                text: "Let's move the launch".into(),
                tokens: Vec::new(),
            })
        );
        assert_eq!(window_passage(" \n", 0, 10), None);
    }
}
