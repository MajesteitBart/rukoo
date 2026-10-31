//! Reads requests, runs them one at a time and writes one response line each.

use std::io::{self, BufRead, Write};
use std::path::Path;
use std::time::Instant;

use serde_json::Value;

use crate::engine::{self, Engine, DEFAULT_THREADS, SAMPLE_RATE};
use crate::long_audio::Recognized;
use crate::protocol::{read_frame, Failure, Frame, Request, Response};

/// More threads than this is a client bug, not a tuning choice.
const MAX_THREADS: u64 = 64;

/// Serves requests until `quit` or the end of `input`.
pub fn serve<R: BufRead, W: Write>(
    input: &mut R,
    output: &mut W,
    engine: &mut Engine,
) -> io::Result<()> {
    loop {
        let response = match read_frame(input)? {
            Frame::End => return Ok(()),
            Frame::Truncated { expected, received } => {
                engine::log(&format!(
                    "stdin closed after {received} of {expected} payload bytes"
                ));
                return Ok(());
            }
            Frame::Invalid { id, error } => {
                Response::failure(Failure::bad_request(error)).with_id(id)
            }
            Frame::Request(request) => {
                if request.str_field("op") == Some("quit") {
                    return Ok(());
                }
                let id = request.id();
                match handle(&request, engine) {
                    Ok(response) => response.with_id(id),
                    Err(failure) => Response::failure(failure).with_id(id),
                }
            }
        };
        output.write_all(&response.to_line())?;
        output.flush()?;
    }
}

fn handle(request: &Request, engine: &mut Engine) -> Result<Response, Failure> {
    match request.fields.get("op") {
        Some(Value::String(op)) => match op.as_str() {
            "ping" => Ok(Response {
                version: Some(env!("CARGO_PKG_VERSION")),
                ..Response::ok()
            }),
            "load" => load(request, engine),
            "transcribe" => transcribe(request, engine),
            "unload" => {
                engine.unload();
                Ok(Response::ok())
            }
            other => Err(Failure::bad_request(format!("Unknown op: {other}."))),
        },
        Some(_) => Err(Failure::bad_request("op must be a string.")),
        None => Err(Failure::bad_request("Request has no op.")),
    }
}

fn load(request: &Request, engine: &mut Engine) -> Result<Response, Failure> {
    match request.field("model") {
        Some(Value::String(model)) if model == "orukeet" => {}
        Some(Value::String(model)) => {
            return Err(Failure::bad_request(format!(
                "Unknown local model: {model}. The worker runs orukeet."
            )))
        }
        _ => return Err(Failure::bad_request("load needs a model.")),
    }
    let dir = match request.field("dir") {
        Some(Value::String(dir)) if !dir.trim().is_empty() => dir,
        _ => return Err(Failure::bad_request("load needs the model folder in dir.")),
    };
    let threads = match request.field("threads") {
        None => DEFAULT_THREADS,
        Some(value) => value
            .as_u64()
            .filter(|threads| (1..=MAX_THREADS).contains(threads))
            .map(|threads| threads as i32)
            .ok_or_else(|| {
                Failure::bad_request(format!(
                    "threads must be a whole number from 1 to {MAX_THREADS}."
                ))
            })?,
    };
    let elapsed = engine.load(Path::new(dir), threads)?;
    Ok(Response {
        load_ms: Some(elapsed.as_millis() as u64),
        ..Response::ok()
    })
}

fn transcribe(request: &Request, engine: &Engine) -> Result<Response, Failure> {
    let Some(payload) = &request.payload else {
        return Err(Failure::bad_request(
            "transcribe needs bytes and that many bytes of audio after the request line.",
        ));
    };
    match request.field("rate") {
        None => {}
        Some(rate) if rate.as_i64() == Some(i64::from(SAMPLE_RATE)) => {}
        Some(_) => {
            return Err(Failure::bad_request(
                "Local transcription requires mono 16-bit audio at 16 kHz.",
            ))
        }
    }
    if payload.len() % 2 != 0 {
        return Err(Failure::bad_request(format!(
            "Audio must be whole 16-bit samples, but bytes is the odd number {}.",
            payload.len()
        )));
    }
    let hotwords = match request.field("hotwords") {
        None => Vec::new(),
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| value.as_str().map(str::to_owned))
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| Failure::bad_request("hotwords must be a list of strings."))?,
        Some(_) => return Err(Failure::bad_request("hotwords must be a list of strings.")),
    };
    let split = match request.field("split") {
        None => true,
        Some(Value::Bool(split)) => *split,
        Some(_) => return Err(Failure::bad_request("split must be true or false.")),
    };

    let pcm: Vec<i16> = payload
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    let started = Instant::now();
    let recognized = engine.transcribe(&pcm, &engine::hotwords_string(&hotwords), split)?;
    Ok(transcribed(
        recognized,
        started.elapsed().as_millis() as u64,
    ))
}

fn transcribed(recognized: Recognized, ms: u64) -> Response {
    // Token times are whole milliseconds; rounding drops the f32 noise from the JSON.
    let round = |values: Vec<f64>| -> Vec<f64> {
        values
            .into_iter()
            .map(|seconds| (seconds * 1000.0).round() / 1000.0)
            .collect()
    };
    Response {
        text: Some(recognized.text),
        tokens: Some(recognized.tokens),
        timestamps: Some(round(recognized.timestamps)),
        durations: Some(round(recognized.durations)),
        ms: Some(ms),
        ..Response::ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;

    fn run(input: &[u8]) -> Vec<Value> {
        let mut output = Vec::new();
        serve(&mut Cursor::new(input), &mut output, &mut Engine::new()).unwrap();
        String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn request(line: &Value, payload: &[u8]) -> Vec<u8> {
        let mut bytes = serde_json::to_vec(line).unwrap();
        bytes.push(b'\n');
        bytes.extend_from_slice(payload);
        bytes
    }

    #[test]
    fn ping_answers_with_the_version() {
        let responses = run(b"{\"op\":\"ping\"}\n");
        assert_eq!(responses, [json!({"ok": true, "version": "0.1.0"})]);
    }

    #[test]
    fn bad_requests_name_the_problem_and_keep_the_id() {
        let mut input = Vec::new();
        for line in [
            json!({"op": "nope", "id": 1}),
            json!({"id": 2}),
            json!({"op": 3, "id": 3}),
            json!({"op": "load", "id": 4, "dir": "x"}),
            json!({"op": "load", "id": 5, "model": "whisper", "dir": "x"}),
            json!({"op": "load", "id": 6, "model": "orukeet"}),
            json!({"op": "load", "id": 7, "model": "orukeet", "dir": "x", "threads": 0}),
            json!({"op": "transcribe", "id": 8}),
        ] {
            input.extend(request(&line, b""));
        }
        input.extend(request(
            &json!({"op": "transcribe", "id": 9, "bytes": 2, "rate": 44100}),
            &[0, 0],
        ));
        input.extend(request(
            &json!({"op": "transcribe", "id": 10, "bytes": 3}),
            &[0, 0, 0],
        ));
        input.extend(request(
            &json!({"op": "transcribe", "id": 11, "bytes": 2, "hotwords": "Bart"}),
            &[0, 0],
        ));
        input.extend(request(
            &json!({"op": "transcribe", "id": 12, "bytes": 2, "hotwords": [1]}),
            &[0, 0],
        ));
        input.extend(request(
            &json!({"op": "transcribe", "id": 13, "bytes": 2, "split": "no"}),
            &[0, 0],
        ));

        let responses = run(&input);
        assert_eq!(responses.len(), 13);
        for (i, response) in responses.iter().enumerate() {
            assert_eq!(response["ok"], json!(false), "{response}");
            assert_eq!(response["id"], json!(i + 1), "{response}");
            assert_eq!(response["kind"], json!("bad_request"), "{response}");
            assert!(response["error"].as_str().is_some_and(|e| !e.is_empty()));
        }
        assert!(responses[9]["error"]
            .as_str()
            .unwrap()
            .contains("odd number 3"));
    }

    #[test]
    fn transcribe_before_load_is_not_loaded() {
        let input = request(
            &json!({"op": "transcribe", "id": 7, "rate": 16000, "bytes": 4}),
            &[0, 0, 0, 0],
        );
        let responses = run(&input);
        assert_eq!(responses[0]["id"], json!(7));
        assert_eq!(responses[0]["kind"], json!("not_loaded"));
    }

    #[test]
    fn quit_stops_before_the_next_request() {
        let responses = run(b"{\"op\":\"ping\"}\n{\"op\":\"quit\"}\n{\"op\":\"ping\"}\n");
        assert_eq!(responses.len(), 1);
    }

    #[test]
    fn unload_without_a_model_is_fine() {
        let responses = run(b"{\"op\":\"unload\",\"id\":\"u\"}\n");
        assert_eq!(responses, [json!({"ok": true, "id": "u"})]);
    }

    #[test]
    fn token_times_are_rounded_to_milliseconds() {
        let response = transcribed(
            Recognized {
                text: "Hi".into(),
                tokens: vec![" Hi".into()],
                timestamps: vec![f64::from(0.12_f32)],
                durations: vec![f64::from(0.08_f32)],
            },
            5,
        );
        let line = String::from_utf8(response.to_line()).unwrap();
        assert_eq!(
            line,
            "{\"ok\":true,\"text\":\"Hi\",\"tokens\":[\" Hi\"],\"timestamps\":[0.12],\"durations\":[0.08],\"ms\":5}\n"
        );
    }
}
