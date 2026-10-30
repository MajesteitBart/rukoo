//! The Orukeet recognizer, configured as Ownkey configures it (`local_transcription.py:14-35`).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use sherpa_onnx::{OfflineRecognizer, OfflineRecognizerConfig};

use crate::long_audio::{self, Recognized};
use crate::onnx;
use crate::protocol::{ErrorKind, Failure};
use crate::stdio::StderrCapture;

pub const SAMPLE_RATE: i32 = 16_000;
/// "Four threads outperform two and os.cpu_count()" (Ownkey `local_transcription.py:15-16`).
pub const DEFAULT_THREADS: i32 = 4;

/// The files the recognizer opens. `LICENSE-WEIGHTS` and `NOTICE.md` travel with the model but
/// aren't read.
pub const MODEL_FILES: [&str; 5] = [
    "encoder.int8.onnx",
    "decoder.int8.onnx",
    "joiner.int8.onnx",
    "tokens.txt",
    "bpe.vocab",
];

/// sherpa-onnx reads these from the encoder and ends the process with `_Exit(-1)` when one is
/// missing, which is what a folder holding some other ONNX model looks like. Checked against
/// sherpa-onnx 2.0.1 by removing each key from Orukeet's encoder.
const ENCODER_METADATA: [&str; 4] = [
    "vocab_size",
    "subsampling_factor",
    "pred_rnn_layers",
    "pred_hidden",
];

/// Longest reason taken from sherpa-onnx's output; the full text stays on stderr.
const MAX_REASON: usize = 400;

struct Loaded {
    dir: PathBuf,
    threads: i32,
    recognizer: OfflineRecognizer,
}

/// Holds at most one loaded model. Only reads the model folder.
#[derive(Default)]
pub struct Engine {
    loaded: Option<Loaded>,
}

impl Engine {
    pub fn new() -> Self {
        Self::default()
    }

    /// Loads Orukeet from `dir`. Loading the model that is already loaded returns at once.
    pub fn load(&mut self, dir: &Path, threads: i32) -> Result<Duration, Failure> {
        check_files(dir)?;
        check_text_files(dir)?;
        check_encoder(dir)?;
        if let Some(loaded) = &self.loaded {
            if loaded.dir == dir && loaded.threads == threads {
                return Ok(Duration::ZERO);
            }
        }
        // Two resident copies of Orukeet would need about 2 GB.
        self.unload();

        let config = orukeet_config(dir, threads);
        let started = Instant::now();
        let capture = StderrCapture::start();
        let recognizer = OfflineRecognizer::create(&config);
        let printed = match capture {
            Ok(capture) => capture.finish(),
            Err(error) => {
                log(&format!(
                    "could not capture stderr during the load: {error}"
                ));
                String::new()
            }
        };
        let Some(recognizer) = recognizer else {
            return Err(load_failure(&printed));
        };
        let elapsed = started.elapsed();
        log(&format!(
            "loaded Orukeet from {} with {threads} threads in {} ms",
            dir.display(),
            elapsed.as_millis()
        ));
        self.loaded = Some(Loaded {
            dir: dir.to_owned(),
            threads,
            recognizer,
        });
        Ok(elapsed)
    }

    pub fn unload(&mut self) {
        if let Some(loaded) = self.loaded.take() {
            drop(loaded);
            log("unloaded Orukeet");
        }
    }

    /// Transcribes 16 kHz mono audio. With `split`, audio over 15 s is cut at pauses and decoded
    /// window by window, as Ownkey does for dictation.
    pub fn transcribe(
        &self,
        pcm: &[i16],
        hotwords: &str,
        split: bool,
    ) -> Result<Recognized, Failure> {
        let loaded = self.loaded.as_ref().ok_or_else(|| {
            Failure::new(ErrorKind::NotLoaded, "No model is loaded. Send load first.")
        })?;
        // Ownkey checks before every decode, so a model removed while it is still in memory shows
        // up as missing instead of working until the next start.
        check_files(&loaded.dir)?;
        if pcm.is_empty() {
            return Ok(Recognized::default());
        }
        let decode = |window: &[i16]| decode(&loaded.recognizer, window, hotwords);
        if split && pcm.len() > long_audio::SPLIT_ABOVE {
            long_audio::transcribe(pcm, decode)
        } else {
            decode(pcm)
        }
    }
}

fn orukeet_config(dir: &Path, threads: i32) -> OfflineRecognizerConfig {
    let file = |name: &str| Some(dir.join(name).to_string_lossy().into_owned());
    let mut config = OfflineRecognizerConfig::default();
    config.feat_config.sample_rate = SAMPLE_RATE;
    // The default is 80 mel bins. Orukeet (NeMo FastConformer) needs 128.
    config.feat_config.feature_dim = 128;
    config.model_config.transducer.encoder = file("encoder.int8.onnx");
    config.model_config.transducer.decoder = file("decoder.int8.onnx");
    config.model_config.transducer.joiner = file("joiner.int8.onnx");
    config.model_config.tokens = file("tokens.txt");
    config.model_config.model_type = Some("nemo_transducer".into());
    config.model_config.num_threads = threads;
    config.model_config.provider = Some("cpu".into());
    // Beam search with the BPE vocabulary lets each request pass dictionary words as hotwords, at
    // the speed of greedy search on this model (Ownkey `local_transcription.py:23-25`).
    config.decoding_method = Some("modified_beam_search".into());
    config.max_active_paths = 4;
    config.model_config.modeling_unit = Some("bpe".into());
    config.model_config.bpe_vocab = file("bpe.vocab");
    config.hotwords_score = 1.5;
    config
}

/// Checks that the folder holds every file the recognizer opens, before sherpa-onnx gets to say so
/// in a less readable way.
fn check_files(dir: &Path) -> Result<(), Failure> {
    match dir.metadata() {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => {
            return Err(Failure::new(
                ErrorKind::MissingModel,
                format!("Model folder not found: {} is not a folder.", dir.display()),
            ))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err(Failure::new(
                ErrorKind::MissingModel,
                format!("Model folder not found: {}.", dir.display()),
            ))
        }
        Err(error) => {
            return Err(Failure::new(
                ErrorKind::Failed,
                format!(
                    "Could not read the model folder {}: {error}.",
                    dir.display()
                ),
            ))
        }
    }
    for name in MODEL_FILES {
        match dir.join(name).metadata() {
            Ok(meta) if meta.is_file() && meta.len() > 0 => {}
            Ok(meta) if meta.is_file() => {
                return Err(Failure::new(
                    ErrorKind::BadModel,
                    format!("Model file is damaged: {name} is empty."),
                ))
            }
            Ok(_) => {
                return Err(Failure::new(
                    ErrorKind::MissingModel,
                    format!("Model missing: {name} is not a file in {}.", dir.display()),
                ))
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Err(Failure::new(
                    ErrorKind::MissingModel,
                    format!("Model missing: {name} is not in {}.", dir.display()),
                ))
            }
            Err(error) => {
                return Err(Failure::new(
                    ErrorKind::Failed,
                    format!("Could not read {name} in {}: {error}.", dir.display()),
                ))
            }
        }
    }
    Ok(())
}

/// sherpa-onnx ends the process instead of returning an error when it can't parse these two
/// files, so they are checked line by line first.
fn check_text_files(dir: &Path) -> Result<(), Failure> {
    check_lines(dir, "tokens.txt", token_line)?;
    check_lines(dir, "bpe.vocab", vocab_line)
}

fn check_lines(dir: &Path, name: &str, valid: fn(&str) -> bool) -> Result<(), Failure> {
    let bytes = fs::read(dir.join(name)).map_err(|error| {
        Failure::new(
            ErrorKind::Failed,
            format!("Could not read {name} in {}: {error}.", dir.display()),
        )
    })?;
    let damaged = |detail: String| {
        Failure::new(
            ErrorKind::BadModel,
            format!("Model file is damaged: {name} {detail}."),
        )
    };
    let text = std::str::from_utf8(&bytes).map_err(|_| damaged("is not UTF-8 text".into()))?;
    match text.lines().position(|line| !valid(line)) {
        Some(index) => Err(damaged(format!("has an unreadable line {}", index + 1))),
        None => Ok(()),
    }
}

/// `<token> <id>`, or only `<id>` for the space token, as sherpa-onnx's `ReadTokens` reads them.
fn token_line(line: &str) -> bool {
    let fields: Vec<&str> = line.split_ascii_whitespace().collect();
    match fields[..] {
        [id] | [_, id] => id.parse::<i32>().is_ok(),
        _ => false,
    }
}

/// `<piece> <score>`, as ssentencepiece reads its vocabulary.
fn vocab_line(line: &str) -> bool {
    let fields: Vec<&str> = line.split_ascii_whitespace().collect();
    matches!(fields[..], [_, score] if score.parse::<f32>().is_ok())
}

fn check_encoder(dir: &Path) -> Result<(), Failure> {
    let name = "encoder.int8.onnx";
    // A file this can't read is left to sherpa-onnx, which reports that without exiting.
    let Ok(Some(entries)) = onnx::metadata(&dir.join(name)) else {
        return Ok(());
    };
    for key in ENCODER_METADATA {
        let value = entries
            .iter()
            .find(|(entry, _)| entry == key)
            .map(|(_, value)| value.trim());
        // sherpa-onnx reads the value with atoi and refuses only an empty or negative one.
        let usable = value.is_some_and(|value| {
            !value.is_empty() && value.parse::<i64>().map_or(true, |number| number >= 0)
        });
        if !usable {
            return Err(Failure::new(
                ErrorKind::BadModel,
                format!(
                    "Model file is damaged: {name} has no {key} in its metadata, \
                     so it isn't an Orukeet encoder."
                ),
            ));
        }
    }
    Ok(())
}

/// sherpa-onnx returns no recognizer and prints the reason on stderr.
fn load_failure(printed: &str) -> Failure {
    let reason = summarize(printed);
    // Running out of memory says nothing about the files; downloading them again wouldn't help.
    let lower = reason.to_lowercase();
    let kind = if lower.contains("bad allocation") || lower.contains("bad_alloc") {
        ErrorKind::Failed
    } else {
        ErrorKind::BadModel
    };
    let reason = if reason.is_empty() {
        "sherpa-onnx refused the model files.".to_owned()
    } else {
        reason
    };
    Failure::new(kind, format!("Could not load Orukeet: {reason}"))
}

/// Turns sherpa-onnx and onnxruntime log lines into one readable reason.
///
/// sherpa-onnx prefixes each line with `<source path>:<function>:<line> `; onnxruntime prints a
/// coloured, timestamped record that sherpa-onnx then repeats, so those records are dropped.
fn summarize(printed: &str) -> String {
    let plain = strip_ansi(printed);
    let mut reasons: Vec<&str> = plain
        .lines()
        .map(str::trim)
        .filter(|line| {
            !line.is_empty() && !line.contains("[E:onnxruntime") && !line.contains("[W:onnxruntime")
        })
        .map(strip_source_prefix)
        .filter(|line| !line.is_empty())
        .collect();
    if reasons.len() > 1 {
        reasons.retain(|line| *line != "Errors in config");
    }
    reasons.dedup();
    let mut reason = reasons.join(" ");
    if reason.len() > MAX_REASON {
        let mut cut = MAX_REASON;
        while !reason.is_char_boundary(cut) {
            cut -= 1;
        }
        reason.truncate(cut);
        reason.push('…');
    }
    reason
}

/// Removes `ESC [ … letter` colour sequences.
fn strip_ansi(text: &str) -> String {
    let mut plain = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for c in chars.by_ref() {
                if c.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            plain.push(c);
        }
    }
    plain
}

/// `D:\a\…\offline-model-config.cc:Validate:105 tokens: …` becomes `tokens: …`.
fn strip_source_prefix(line: &str) -> &str {
    let bytes = line.as_bytes();
    for (i, &byte) in bytes.iter().enumerate() {
        if byte != b':' {
            continue;
        }
        let digits = bytes[i + 1..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count();
        let after = i + 1 + digits;
        if digits > 0 && bytes.get(after) == Some(&b' ') {
            let prefix = &line[..i];
            // Only a source location qualifies, not a time such as 18:43.
            if prefix.contains(".cc:") || prefix.contains(".h:") || prefix.contains(".cpp:") {
                return line[after + 1..].trim();
            }
        }
    }
    line
}

/// Ownkey's `hotwords_string`: each term on one line of collapsed whitespace, joined with `/`,
/// which sherpa-onnx reads as the separator.
pub fn hotwords_string(terms: &[String]) -> String {
    terms
        .iter()
        .map(|term| {
            // Differs from Ownkey on purpose: "/" and control characters become spaces before
            // collapsing, so "a / b" gives "a b" and a lone "/" no empty hotword.
            let cleaned: String = term
                .chars()
                .map(|c| if c == '/' || c.is_control() { ' ' } else { c })
                .collect();
            cleaned.split_whitespace().collect::<Vec<_>>().join(" ")
        })
        .filter(|term| !term.is_empty())
        .collect::<Vec<_>>()
        .join("/")
}

fn decode(
    recognizer: &OfflineRecognizer,
    pcm: &[i16],
    hotwords: &str,
) -> Result<Recognized, Failure> {
    let samples: Vec<f32> = pcm.iter().map(|&s| f32::from(s) / 32_768.0).collect();
    let stream = if hotwords.is_empty() {
        recognizer.create_stream()
    } else {
        recognizer.create_stream_with_hotwords(hotwords)
    };
    stream.accept_waveform(SAMPLE_RATE, &samples);
    recognizer.decode(&stream);
    let result = stream
        .get_result()
        .ok_or_else(|| Failure::new(ErrorKind::Failed, "Orukeet returned no result."))?;
    let seconds = |values: Option<Vec<f32>>| -> Vec<f64> {
        values
            .unwrap_or_default()
            .into_iter()
            .map(f64::from)
            .collect()
    };
    Ok(Recognized {
        text: result.text.trim().to_owned(),
        tokens: result.tokens,
        timestamps: seconds(result.timestamps),
        durations: seconds(result.durations),
    })
}

pub fn log(message: &str) {
    eprintln!("rukoo-voice-local: {message}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    pub fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "rukoo-voice-local-{name}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Readable text files and ONNX files that aren't models.
    fn model_folder(name: &str) -> PathBuf {
        let dir = temp_dir(name);
        for file in &MODEL_FILES[..3] {
            fs::write(dir.join(file), b"not a model").unwrap();
        }
        fs::write(
            dir.join("tokens.txt"),
            "<unk> 0\n\u{2581}the 1\n 2\n<blk> 3\n",
        )
        .unwrap();
        fs::write(dir.join("bpe.vocab"), "<unk>\t0.0\r\n\u{2581}the\t-1.5\r\n").unwrap();
        dir
    }

    #[test]
    fn a_missing_folder_or_file_is_missing_model() {
        let mut engine = Engine::new();
        let gone = temp_dir("gone").join("nothing-here");
        let failure = engine.load(&gone, DEFAULT_THREADS).unwrap_err();
        assert_eq!(failure.kind, ErrorKind::MissingModel);
        assert!(
            failure.message.contains("Model folder not found"),
            "{failure:?}"
        );

        let dir = model_folder("one-missing");
        fs::remove_file(dir.join("joiner.int8.onnx")).unwrap();
        let failure = engine.load(&dir, DEFAULT_THREADS).unwrap_err();
        assert_eq!(failure.kind, ErrorKind::MissingModel);
        assert!(failure.message.contains("joiner.int8.onnx"), "{failure:?}");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_empty_file_is_bad_model() {
        let dir = model_folder("empty");
        fs::write(dir.join("tokens.txt"), b"").unwrap();
        let failure = Engine::new().load(&dir, DEFAULT_THREADS).unwrap_err();
        assert_eq!(failure.kind, ErrorKind::BadModel);
        assert!(failure.message.contains("tokens.txt"), "{failure:?}");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn sherpa_reason_for_a_damaged_file_reaches_the_error() {
        let dir = model_folder("damaged");
        let mut engine = Engine::new();
        let failure = engine.load(&dir, DEFAULT_THREADS).unwrap_err();
        assert_eq!(failure.kind, ErrorKind::BadModel);
        assert!(
            failure.message.starts_with("Could not load Orukeet: "),
            "{failure:?}"
        );
        assert!(failure.message.contains("encoder.int8.onnx"), "{failure:?}");
        assert!(
            failure.message.contains("Protobuf parsing failed"),
            "{failure:?}"
        );
        assert!(engine.loaded.is_none());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn unreadable_text_files_are_bad_model_before_sherpa_sees_them() {
        for (file, content) in [
            ("tokens.txt", "not a model\n"),
            ("tokens.txt", "<unk> 0\n\n<blk> 1\n"),
            ("tokens.txt", "<unk> zero\n"),
            ("bpe.vocab", "not a model\n"),
            ("bpe.vocab", "<unk>\t0.0\n\u{2581}the\n"),
        ] {
            let dir = model_folder("text");
            fs::write(dir.join(file), content).unwrap();
            let failure = Engine::new().load(&dir, DEFAULT_THREADS).unwrap_err();
            assert_eq!(failure.kind, ErrorKind::BadModel, "{content:?}");
            let expected = format!("Model file is damaged: {file} has an unreadable line");
            assert!(failure.message.starts_with(&expected), "{failure:?}");
            fs::remove_dir_all(dir).unwrap();
        }
        let dir = model_folder("binary");
        fs::write(dir.join("tokens.txt"), [0xff, 0xfe, b' ', b'1']).unwrap();
        let failure = Engine::new().load(&dir, DEFAULT_THREADS).unwrap_err();
        assert_eq!(
            failure.message,
            "Model file is damaged: tokens.txt is not UTF-8 text."
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_encoder_without_nemo_metadata_is_bad_model() {
        let complete = [
            ("vocab_size", "8192"),
            ("subsampling_factor", "8"),
            ("pred_rnn_layers", "2"),
            ("pred_hidden", "640"),
        ];
        let dir = model_folder("metadata");
        let encoder = dir.join("encoder.int8.onnx");

        fs::write(&encoder, crate::onnx::tests::model(&complete)).unwrap();
        assert_eq!(check_encoder(&dir), Ok(()));

        fs::write(&encoder, crate::onnx::tests::model(&complete[1..])).unwrap();
        let failure = check_encoder(&dir).unwrap_err();
        assert_eq!(failure.kind, ErrorKind::BadModel);
        assert!(failure.message.contains("has no vocab_size"), "{failure:?}");

        let negative = [complete[0], complete[1], complete[2], ("pred_hidden", "-1")];
        fs::write(&encoder, crate::onnx::tests::model(&negative)).unwrap();
        assert!(check_encoder(&dir)
            .unwrap_err()
            .message
            .contains("pred_hidden"));

        // Not ONNX at all: left to sherpa-onnx, which says so without exiting.
        fs::write(&encoder, b"not a model").unwrap();
        assert_eq!(check_encoder(&dir), Ok(()));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn token_and_vocab_lines() {
        assert!(token_line("<unk> 0"));
        assert!(token_line("\u{2581}the 17"));
        assert!(token_line("17"));
        assert!(token_line("<blk> 8192\r"));
        assert!(!token_line(""));
        assert!(!token_line("a b 1"));
        assert!(!token_line("a 1x"));
        assert!(vocab_line("<unk>\t0.0"));
        assert!(vocab_line("\u{2581}the -12.25"));
        assert!(!vocab_line("<unk>"));
        assert!(!vocab_line("<unk> zero"));
    }

    #[test]
    fn transcribe_needs_a_loaded_model() {
        let failure = Engine::new().transcribe(&[0; 160], "", true).unwrap_err();
        assert_eq!(failure.kind, ErrorKind::NotLoaded);
    }

    // Lines as sherpa-onnx 2.0.1 and onnxruntime printed them on Windows.
    const MISSING_TOKENS: &str = "D:\\a\\sherpa-onnx\\sherpa-onnx\\sherpa-onnx\\csrc\\offline-model-config.cc:Validate:105 tokens: 'E:\\x/tokens.txt' does not exist\nD:\\a\\sherpa-onnx\\sherpa-onnx\\sherpa-onnx\\c-api\\c-api.cc:SherpaOnnxCreateOfflineRecognizer:709 Errors in config\n";
    const ORT_FAILURE: &str = "\u{1b}[1;31m2026-10-30 18:43:51.3439778 [E:onnxruntime:, inference_session.cc:2883 onnxruntime::InferenceSession::Initialize::<lambda_5>::operator ()] Exception during initialization: indexes should have been populated.\u{1b}[m\nD:\\a\\sherpa-onnx\\sherpa-onnx\\sherpa-onnx\\c-api\\c-api.cc:SherpaOnnxCreateOfflineRecognizer:719 Failed to create OfflineRecognizer: Exception during initialization: indexes should have been populated.\n";

    #[test]
    fn summarizes_sherpa_output() {
        assert_eq!(
            summarize(MISSING_TOKENS),
            "tokens: 'E:\\x/tokens.txt' does not exist"
        );
        assert_eq!(
            summarize(ORT_FAILURE),
            "Failed to create OfflineRecognizer: Exception during initialization: indexes should have been populated."
        );
        assert_eq!(summarize("plain text at 18:43 \n\n"), "plain text at 18:43");
        assert_eq!(summarize(""), "");
        let long = format!("x.cc:f:1 {}", "é".repeat(400));
        let summary = summarize(&long);
        assert!(summary.len() <= MAX_REASON + '…'.len_utf8());
        assert!(summary.ends_with('…'));
    }

    #[test]
    fn running_out_of_memory_is_not_a_bad_model() {
        let failure =
            load_failure("x.cc:Create:1 Failed to create OfflineRecognizer: bad allocation\n");
        assert_eq!(failure.kind, ErrorKind::Failed);
        let failure = load_failure("");
        assert_eq!(failure.kind, ErrorKind::BadModel);
        assert_eq!(
            failure.message,
            "Could not load Orukeet: sherpa-onnx refused the model files."
        );
    }

    #[test]
    fn hotwords_follow_ownkey() {
        let terms: Vec<String> = ["Bart", "  Rukoo \t Mail ", "", "a / b", "/", "x\u{0}y"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(hotwords_string(&terms), "Bart/Rukoo Mail/a b/x y");
        assert_eq!(hotwords_string(&[]), "");
    }
}
