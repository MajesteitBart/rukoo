//! The worker with the real NeMo-Speech.cpp runtime and Nemotron 3 Diarization, on the AMI
//! meeting excerpt. Skips unless all three variables are set, as `voice/scripts/speaker-assets.ps1`
//! prints them:
//!
//! - `RUKOO_VOICE_TEST_NEMO_DIR`: the runtime folder, holding `nemo_speech_asr_c.dll`.
//! - `RUKOO_VOICE_TEST_NEMOTRON`: `Nemotron-3-Diarization.q8_0.gguf`, or the folder holding it.
//! - `RUKOO_VOICE_TEST_AMI`: the folder holding `ami_en2002d_2132.wav`, or the WAV itself.

mod common;

use std::fs;
use std::path::PathBuf;
use std::process::Command;

use common::{assert_failure, probs, TempDir, Worker, EXE};
use serde_json::{json, Value};

const MODEL_FILE: &str = "Nemotron-3-Diarization.q8_0.gguf";
const AMI_WAV: &str = "ami_en2002d_2132.wav";
/// The excerpt is 60 s, so 6,000 frames of 10 ms.
const AMI_FRAMES: i64 = 6_000;
/// One chunk of the live geometry: 38 encoder frames of 80 ms.
const CHUNK: i64 = 38 * 8;
const SPEAKERS: usize = 8;

struct Assets {
    runtime: PathBuf,
    model: PathBuf,
    wav: PathBuf,
}

fn file_in(variable: &str, name: &str) -> Option<PathBuf> {
    let path = PathBuf::from(std::env::var_os(variable)?);
    Some(if path.is_dir() { path.join(name) } else { path })
}

fn assets() -> Option<Assets> {
    let found = (|| {
        Some(Assets {
            runtime: PathBuf::from(std::env::var_os("RUKOO_VOICE_TEST_NEMO_DIR")?),
            model: file_in("RUKOO_VOICE_TEST_NEMOTRON", MODEL_FILE)?,
            wav: file_in("RUKOO_VOICE_TEST_AMI", AMI_WAV)?,
        })
    })();
    if found.is_none() {
        eprintln!(
            "skipped: set RUKOO_VOICE_TEST_NEMO_DIR, RUKOO_VOICE_TEST_NEMOTRON and RUKOO_VOICE_TEST_AMI (voice/scripts/speaker-assets.ps1)"
        );
    }
    found
}

fn load(assets: &Assets) -> Value {
    json!({"op": "load", "id": 2, "runtime": assets.runtime, "model": assets.model,
           "preset": "v3-streaming", "chunkFrames": 38, "rightContextFrames": 1})
}

/// The excerpt's samples as raw s16le bytes, after the canonical 44-byte header.
fn ami_pcm(assets: &Assets) -> Vec<u8> {
    let bytes = fs::read(&assets.wav).expect("read the AMI excerpt");
    assert_eq!(&bytes[..4], b"RIFF");
    assert_eq!(&bytes[36..40], b"data");
    bytes[44..].to_vec()
}

fn check_frames(response: &Value, expected_first: i64) -> i64 {
    assert_eq!(response["ok"], json!(true), "{response}");
    let first = response["first"].as_i64().unwrap();
    let frames = response["frames"].as_i64().unwrap();
    let count = response["count"].as_i64().unwrap();
    assert_eq!(first, expected_first, "{response}");
    assert_eq!(first + frames, count, "{response}");
    let values = probs(response);
    assert_eq!(values.len(), frames as usize * SPEAKERS);
    assert!(
        values.iter().all(|p| (0.0..=1.0).contains(p)),
        "probabilities outside [0, 1]"
    );
    count
}

#[test]
fn labels_the_ami_excerpt_in_one_second_pushes() {
    let Some(assets) = assets() else { return };
    let mut worker = Worker::spawn();
    let loaded = worker.request(&load(&assets));
    assert_eq!(loaded["ok"], json!(true), "{loaded}\n{}", worker.stderr());
    assert_eq!(loaded["speakers"], json!(SPEAKERS));
    assert_eq!(loaded["secondsPerFrame"], json!(0.01));
    assert!(loaded["loadMs"].is_u64());
    assert_eq!(
        worker.request(&json!({"op": "open", "id": 3})),
        json!({"id": 3, "ok": true})
    );

    let pcm = ami_pcm(&assets);
    let mut count = 0;
    let mut speech = [0f32; SPEAKERS];
    for (n, second) in pcm.chunks(32_000).enumerate() {
        let response = worker.request_with(
            &json!({"op": "push", "id": 10 + n, "rate": 16000, "bytes": second.len()}),
            second,
        );
        let values = probs(&response);
        for frame in values.chunks_exact(SPEAKERS) {
            for (speaker, p) in frame.iter().enumerate() {
                if *p > 0.5 {
                    speech[speaker] += 0.01;
                }
            }
        }
        count = check_frames(&response, count);
    }
    // The newest audio waits for its chunk: frames trail the audio pushed so far.
    assert!(count < AMI_FRAMES, "{count}");
    let tail = worker.request(&json!({"op": "finish", "id": 99}));
    let total = check_frames(&tail, count);
    assert!(
        (total - AMI_FRAMES).abs() <= CHUNK,
        "{total} frames for 60 s of audio"
    );
    for frame in probs(&tail).chunks_exact(SPEAKERS) {
        for (speaker, p) in frame.iter().enumerate() {
            if *p > 0.5 {
                speech[speaker] += 0.01;
            }
        }
    }
    // Three people take turns in the excerpt; the model should hear at least three voices for
    // a few seconds each.
    let voices = speech.iter().filter(|seconds| **seconds >= 2.0).count();
    assert!(voices >= 3, "speech per speaker slot: {speech:?}");

    // The stream is finished; a new one starts from frame 0.
    assert_failure(
        &worker.request_with(&json!({"op": "push", "bytes": 2}), &[0, 0]),
        "not_open",
    );
    assert_eq!(worker.request(&json!({"op": "open"}))["ok"], json!(true));
    let again = worker.request_with(
        &json!({"op": "push", "id": 100, "bytes": 320_000}),
        &pcm[..320_000],
    );
    check_frames(&again, 0);
    worker.send(&json!({"op": "quit"}));
    assert_eq!(worker.wait().code(), Some(0));
}

#[test]
fn a_second_load_is_refused() {
    let Some(assets) = assets() else { return };
    let mut worker = Worker::spawn();
    assert_eq!(worker.request(&load(&assets))["ok"], json!(true));
    assert_failure(&worker.request(&load(&assets)), "bad_request");
}

#[test]
fn a_bad_model_is_refused_without_crashing() {
    let Some(assets) = assets() else { return };
    let temp = TempDir::new("model");
    let mut worker = Worker::spawn();

    let missing = worker.request(&json!({"op": "load", "runtime": assets.runtime,
                                         "model": temp.path().join(MODEL_FILE)}));
    assert_failure(&missing, "model");

    let garbage = temp.path().join("garbage.gguf");
    fs::write(&garbage, vec![0x47u8; 4096]).unwrap();
    let refused =
        worker.request(&json!({"op": "load", "runtime": assets.runtime, "model": garbage}));
    assert_failure(&refused, "model");
    assert!(
        refused["error"]
            .as_str()
            .unwrap()
            .starts_with("Speaker labels failed while loading the model."),
        "{refused}"
    );

    // The worker is still there, and the real model loads after the refusals.
    assert_eq!(worker.request(&json!({"op": "ping"}))["ok"], json!(true));
    assert_eq!(worker.request(&load(&assets))["ok"], json!(true));
}

#[test]
fn the_self_test_hears_at_least_three_speakers() {
    let Some(assets) = assets() else { return };
    let temp = TempDir::new("report");
    let report_path = temp.path().join("report.json");
    let output = Command::new(EXE)
        .arg("--self-test")
        .arg("--runtime")
        .arg(&assets.runtime)
        .arg("--model")
        .arg(&assets.model)
        .arg("--wav")
        .arg(&assets.wav)
        .arg("--report")
        .arg(&report_path)
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "{stderr}");
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert_eq!(stdout.lines().count(), 1, "{stdout}");
    let report: Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(
        report,
        serde_json::from_slice::<Value>(&fs::read(&report_path).unwrap()).unwrap()
    );
    assert!(report["speakers"].as_u64().unwrap() >= 3, "{report}");
    assert!(
        report["frames"].as_i64().unwrap() >= AMI_FRAMES - 100,
        "{report}"
    );
    assert!(report["segments"].as_u64().unwrap() >= 3, "{report}");
    assert!(report["realtimeFactor"].as_f64().unwrap() > 1.0, "{report}");
    eprintln!("self-test: {report}");
}
