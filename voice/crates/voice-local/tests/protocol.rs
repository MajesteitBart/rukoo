//! The worker protocol, without a model.

mod common;

use std::fs;
use std::path::Path;

use common::{listing, TempDir, Worker};
use serde_json::{json, Value};

fn assert_failure(response: &Value, kind: &str) {
    assert_eq!(response["ok"], json!(false), "{response}");
    assert_eq!(response["kind"], json!(kind), "{response}");
    assert!(
        response["error"].as_str().is_some_and(|e| !e.is_empty()),
        "{response}"
    );
}

fn assert_alive(worker: &mut Worker) {
    assert_eq!(
        worker.request(&json!({"op": "ping"})),
        json!({"ok": true, "version": "0.1.0"})
    );
}

/// Text files the recognizer can read and ONNX files that aren't models.
fn broken_model(dir: &Path) {
    for name in ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx"] {
        fs::write(dir.join(name), b"not an onnx model").unwrap();
    }
    fs::write(dir.join("tokens.txt"), "<unk> 0\n\u{2581}the 1\n<blk> 2\n").unwrap();
    fs::write(dir.join("bpe.vocab"), "<unk>\t0.0\n\u{2581}the\t-1.5\n").unwrap();
}

fn load(dir: &Path) -> Value {
    json!({"op": "load", "model": "orukeet", "dir": dir, "threads": 1})
}

#[test]
fn ping_reports_the_version() {
    let mut worker = Worker::spawn();
    assert_alive(&mut worker);
    assert_eq!(
        worker.request(&json!({"op": "ping", "id": "p"})),
        json!({"ok": true, "id": "p", "version": "0.1.0"})
    );
}

#[test]
fn malformed_lines_get_bad_request_and_the_worker_reads_on() {
    let mut worker = Worker::spawn();
    worker.send_raw(b"not json\n[1,2]\n{}\n\n{\"op\":\"nope\",\"id\":5}\r\n");
    for _ in 0..3 {
        assert_failure(&worker.recv(), "bad_request");
    }
    let unknown = worker.recv();
    assert_failure(&unknown, "bad_request");
    assert_eq!(unknown["id"], json!(5));
    assert!(unknown["error"].as_str().unwrap().contains("nope"));

    worker.send_raw(&vec![b'x'; 100_000]);
    worker.send_raw(b"\n");
    assert_failure(&worker.recv(), "bad_request");
    assert_alive(&mut worker);
}

#[test]
fn an_odd_byte_count_is_refused_without_losing_the_framing() {
    let mut worker = Worker::spawn();
    let response = worker.request_with(
        &json!({"op": "transcribe", "id": 1, "rate": 16000, "bytes": 3}),
        &[1, 2, 3],
    );
    assert_failure(&response, "bad_request");
    assert_eq!(response["id"], json!(1));
    assert_alive(&mut worker);
}

#[test]
fn bytes_past_the_declared_count_are_read_as_the_next_line() {
    let mut worker = Worker::spawn();
    worker.send_with(
        &json!({"op": "transcribe", "id": 2, "bytes": 4}),
        b"\0\0\0\0stray audio\n",
    );
    let response = worker.recv();
    assert_failure(&response, "not_loaded");
    assert_eq!(response["id"], json!(2));
    assert_failure(&worker.recv(), "bad_request");
    assert_alive(&mut worker);
}

#[test]
fn an_unusable_byte_count_is_refused() {
    let mut worker = Worker::spawn();
    for bytes in [json!(-4), json!(2.5), json!("4")] {
        let response = worker.request(&json!({"op": "transcribe", "id": 3, "bytes": bytes}));
        assert_failure(&response, "bad_request");
        assert_eq!(response["id"], json!(3));
    }
    assert_alive(&mut worker);
}

#[test]
fn stdin_closing_inside_a_payload_ends_the_worker_quietly() {
    let mut worker = Worker::spawn();
    worker.send_with(&json!({"op": "transcribe", "bytes": 100}), &[0; 10]);
    worker.close_stdin();
    assert!(worker.wait().success());
    assert!(
        worker
            .stderr()
            .contains("stdin closed after 10 of 100 payload bytes"),
        "{}",
        worker.stderr()
    );
}

#[test]
fn transcribe_before_load_is_not_loaded() {
    let mut worker = Worker::spawn();
    let response = worker.request_with(
        &json!({"op": "transcribe", "id": 7, "rate": 16000, "bytes": 4, "hotwords": ["Bart"]}),
        &[0; 4],
    );
    assert_failure(&response, "not_loaded");
    assert_eq!(response["id"], json!(7));
}

#[test]
fn load_from_a_missing_folder_is_missing_model() {
    let temp = TempDir::new("missing");
    let mut worker = Worker::spawn();
    let response = worker.request(&load(&temp.path().join("orukeet")));
    assert_failure(&response, "missing_model");
    assert!(response["error"]
        .as_str()
        .unwrap()
        .contains("Model folder not found"));

    broken_model(temp.path());
    fs::remove_file(temp.path().join("bpe.vocab")).unwrap();
    let response = worker.request(&load(temp.path()));
    assert_failure(&response, "missing_model");
    assert!(response["error"].as_str().unwrap().contains("bpe.vocab"));
}

#[test]
fn load_from_a_folder_with_a_broken_file_is_bad_model() {
    let temp = TempDir::new("broken");
    broken_model(temp.path());
    let before = listing(temp.path());

    let mut worker = Worker::spawn();
    let response = worker.request(&load(temp.path()));
    assert_failure(&response, "bad_model");
    let error = response["error"].as_str().unwrap();
    assert!(error.starts_with("Could not load Orukeet: "), "{error}");
    assert!(error.contains("encoder.int8.onnx"), "{error}");
    assert!(error.contains("Protobuf parsing failed"), "{error}");
    // The worker survives a refused model and stays unloaded.
    assert_alive(&mut worker);
    let response = worker.request_with(&json!({"op": "transcribe", "bytes": 2}), &[0, 0]);
    assert_failure(&response, "not_loaded");
    // What sherpa-onnx printed still reaches stderr.
    assert!(
        worker.stderr().contains("Protobuf parsing failed"),
        "{}",
        worker.stderr()
    );
    assert_eq!(listing(temp.path()), before);

    // A tokens file sherpa-onnx would exit on is caught before it gets there.
    fs::write(temp.path().join("tokens.txt"), "not a tokens file\n").unwrap();
    let before_tokens = listing(temp.path());
    let response = worker.request(&load(temp.path()));
    assert_failure(&response, "bad_model");
    assert!(response["error"].as_str().unwrap().contains("tokens.txt"));
    assert_alive(&mut worker);

    worker.send(&json!({"op": "quit"}));
    assert!(worker.wait().success());
    assert_eq!(listing(temp.path()), before_tokens);
}

#[test]
fn load_checks_its_fields() {
    let temp = TempDir::new("fields");
    let mut worker = Worker::spawn();
    for request in [
        json!({"op": "load", "dir": temp.path()}),
        json!({"op": "load", "model": "whisper", "dir": temp.path()}),
        json!({"op": "load", "model": "orukeet"}),
        json!({"op": "load", "model": "orukeet", "dir": temp.path(), "threads": 0}),
    ] {
        assert_failure(&worker.request(&request), "bad_request");
    }
}

#[test]
fn unload_is_always_fine() {
    let mut worker = Worker::spawn();
    assert_eq!(
        worker.request(&json!({"op": "unload"})),
        json!({"ok": true})
    );
}

#[test]
fn quit_exits_cleanly_without_answering() {
    let mut worker = Worker::spawn();
    assert_alive(&mut worker);
    worker.send_raw(b"{\"op\":\"quit\"}\n{\"op\":\"ping\"}\n");
    assert!(worker.wait().success());
}

#[test]
fn stdin_eof_exits_cleanly() {
    let mut worker = Worker::spawn();
    assert_alive(&mut worker);
    worker.close_stdin();
    assert!(worker.wait().success());
}
