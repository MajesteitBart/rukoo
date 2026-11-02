//! Reads requests, runs them one at a time and writes one response line each.

use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::time::Instant;

use base64::Engine as _;
use serde_json::Value;

use crate::backend::{
    Backend, Frames, LoadRequest, Loaded, CHUNK_FRAMES, PRESET, RIGHT_CONTEXT_FRAMES, SAMPLE_RATE,
};
use crate::cpu;
use crate::protocol::{read_frame, ErrorKind, Failure, Frame, Request, Response};

/// Chunk and context sizes beyond this are a client bug, not a tuning choice.
const MAX_GEOMETRY_FRAMES: i64 = 1000;

pub fn log(message: &str) {
    eprintln!("rukoo-voice-speakers: {message}");
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StreamState {
    Closed,
    Open,
    Finished,
}

/// One model and at most one stream, for the life of the process.
pub struct Worker<B: Backend> {
    backend: B,
    loaded: Option<Loaded>,
    stream: StreamState,
}

impl<B: Backend> Worker<B> {
    pub fn new(backend: B) -> Self {
        Worker {
            backend,
            loaded: None,
            stream: StreamState::Closed,
        }
    }

    /// Closes the stream before the process ends, so the runtime frees it while the model lives.
    pub fn close(&mut self) {
        if self.stream != StreamState::Closed {
            self.backend.close();
            self.stream = StreamState::Closed;
        }
    }

    fn handle(&mut self, request: &Request) -> Result<Response, Failure> {
        match request.fields.get("op") {
            Some(Value::String(op)) => match op.as_str() {
                "ping" => Ok(Response {
                    pid: Some(std::process::id()),
                    version: Some(env!("CARGO_PKG_VERSION")),
                    cpu: Some(cpu::detect()),
                    ..Response::ok()
                }),
                "load" => self.load(request),
                "open" => self.open(),
                "push" => self.push(request),
                "finish" => self.finish(),
                "close" => {
                    self.close();
                    Ok(Response::ok())
                }
                other => Err(Failure::bad_request(format!("Unknown op: {other}."))),
            },
            Some(_) => Err(Failure::bad_request("op must be a string.")),
            None => Err(Failure::bad_request("Request has no op.")),
        }
    }

    fn load(&mut self, request: &Request) -> Result<Response, Failure> {
        let load = load_request(request)?;
        if self.loaded.is_some() {
            return Err(Failure::bad_request(
                "The model is already loaded. A worker loads once; start a new one for another model.",
            ));
        }
        log(&format!(
            "loading the runtime from {} and the model {}",
            load.runtime.display(),
            load.model.display()
        ));
        let started = Instant::now();
        let loaded = self
            .backend
            .load(&load)
            .inspect_err(|failure| log(&format!("load failed: {}", failure.message)))?;
        let load_ms = started.elapsed().as_millis() as u64;
        log(&format!(
            "loaded in {load_ms} ms: {} speakers, {} s per frame, runtime {}",
            loaded.speakers,
            loaded.seconds_per_frame,
            loaded
                .runtime_version
                .as_deref()
                .unwrap_or("of unknown version")
        ));
        let response = Response {
            speakers: Some(loaded.speakers),
            seconds_per_frame: Some(loaded.seconds_per_frame),
            load_ms: Some(load_ms),
            runtime_version: loaded.runtime_version.clone(),
            ..Response::ok()
        };
        self.loaded = Some(loaded);
        Ok(response)
    }

    fn open(&mut self) -> Result<Response, Failure> {
        if self.loaded.is_none() {
            return Err(Failure::bad_request(
                "open needs a loaded model; send load first.",
            ));
        }
        self.stream = StreamState::Closed;
        self.backend
            .open()
            .inspect_err(|failure| log(&format!("open failed: {}", failure.message)))?;
        self.stream = StreamState::Open;
        Ok(Response::ok())
    }

    fn push(&mut self, request: &Request) -> Result<Response, Failure> {
        let Some(payload) = &request.payload else {
            return Err(Failure::bad_request(
                "push needs bytes and that many bytes of audio after the request line.",
            ));
        };
        match request.field("rate") {
            None => {}
            Some(rate) if rate.as_u64() == Some(u64::from(SAMPLE_RATE)) => {}
            Some(_) => {
                return Err(Failure::bad_request(
                    "Speaker labels take mono 16-bit audio at 16 kHz.",
                ))
            }
        }
        if payload.len() % 2 != 0 {
            return Err(Failure::bad_request(format!(
                "Audio must be whole 16-bit samples, but bytes is the odd number {}.",
                payload.len()
            )));
        }
        self.require_open()?;
        let pcm: Vec<i16> = payload
            .chunks_exact(2)
            .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        let frames = self
            .backend
            .push(&pcm)
            .inspect_err(|failure| log(&format!("push failed: {}", failure.message)))?;
        Ok(self.frames(frames))
    }

    fn finish(&mut self) -> Result<Response, Failure> {
        self.require_open()?;
        // Whatever happens, the stream takes no more audio.
        self.stream = StreamState::Finished;
        let frames = self
            .backend
            .finish()
            .inspect_err(|failure| log(&format!("finish failed: {}", failure.message)))?;
        log(&format!("finished the stream at frame {}", frames.count));
        Ok(self.frames(frames))
    }

    fn require_open(&self) -> Result<(), Failure> {
        match self.stream {
            StreamState::Open => Ok(()),
            StreamState::Closed => Err(Failure::new(
                ErrorKind::NotOpen,
                "No stream is open; send open first.",
            )),
            StreamState::Finished => Err(Failure::new(
                ErrorKind::NotOpen,
                "The stream is finished; send open for a new one.",
            )),
        }
    }

    fn frames(&self, frames: Frames) -> Response {
        let speakers = self.loaded.as_ref().map_or(1, |loaded| loaded.speakers);
        let mut bytes = Vec::with_capacity(frames.values.len() * 4);
        for value in &frames.values {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        Response {
            first: Some(frames.first),
            frames: Some(frames.values.len() / speakers),
            count: Some(frames.count),
            probs: Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
            ..Response::ok()
        }
    }
}

fn load_request(request: &Request) -> Result<LoadRequest, Failure> {
    let path = |name: &str, what: &str| match request.field(name) {
        Some(Value::String(path)) if !path.trim().is_empty() => Ok(PathBuf::from(path)),
        _ => Err(Failure::bad_request(format!(
            "load needs {what} in {name}."
        ))),
    };
    let runtime = path("runtime", "the runtime folder")?;
    let model = path("model", "the model file")?;
    let preset = match request.field("preset") {
        None => PRESET.to_owned(),
        Some(Value::String(preset)) if !preset.trim().is_empty() => preset.clone(),
        Some(_) => {
            return Err(Failure::bad_request(
                "preset must be a preset name such as v3-streaming.",
            ))
        }
    };
    Ok(LoadRequest {
        runtime,
        model,
        preset,
        chunk_frames: geometry(request, "chunkFrames", CHUNK_FRAMES)?,
        right_context_frames: geometry(request, "rightContextFrames", RIGHT_CONTEXT_FRAMES)?,
    })
}

/// A frame count in 80 ms encoder frames; 0 keeps the preset's value.
fn geometry(request: &Request, name: &str, default: i32) -> Result<i32, Failure> {
    match request.field(name) {
        None => Ok(default),
        Some(value) => value
            .as_i64()
            .filter(|frames| (0..=MAX_GEOMETRY_FRAMES).contains(frames))
            .map(|frames| frames as i32)
            .ok_or_else(|| {
                Failure::bad_request(format!(
                    "{name} must be a whole number from 0 to {MAX_GEOMETRY_FRAMES}."
                ))
            }),
    }
}

/// Serves requests until `quit` or the end of `input`.
pub fn serve<R: BufRead, W: Write, B: Backend>(
    input: &mut R,
    output: &mut W,
    worker: &mut Worker<B>,
) -> io::Result<()> {
    loop {
        let response = match read_frame(input)? {
            Frame::End => return Ok(()),
            Frame::Truncated { expected, received } => {
                log(&format!(
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
                match worker.handle(&request) {
                    Ok(response) => response.with_id(id),
                    Err(failure) => Response::failure(failure).with_id(id),
                }
            }
        };
        output.write_all(&response.to_line())?;
        output.flush()?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;

    /// Two speakers, one frame per 160 samples (10 ms); a frame's values are its index and minus
    /// its index, so a test can see which frames came back.
    #[derive(Default)]
    struct Fake {
        fail_load: Option<Failure>,
        loads: Vec<LoadRequest>,
        opens: usize,
        closes: usize,
        samples: u64,
        read: u64,
    }

    impl Fake {
        fn take(&mut self, count: u64) -> Frames {
            let values = (self.read..count)
                .flat_map(|frame| [frame as f32, -(frame as f32)])
                .collect();
            let frames = Frames {
                first: self.read,
                values,
                count,
            };
            self.read = count;
            frames
        }
    }

    impl Backend for Fake {
        fn load(&mut self, request: &LoadRequest) -> Result<Loaded, Failure> {
            self.loads.push(request.clone());
            if let Some(failure) = self.fail_load.take() {
                return Err(failure);
            }
            Ok(Loaded {
                speakers: 2,
                seconds_per_frame: 0.01,
                runtime_version: Some("test".into()),
            })
        }

        fn open(&mut self) -> Result<(), Failure> {
            self.opens += 1;
            self.samples = 0;
            self.read = 0;
            Ok(())
        }

        fn push(&mut self, pcm: &[i16]) -> Result<Frames, Failure> {
            self.samples += pcm.len() as u64;
            // Like the runtime, the newest frames wait for the next chunk.
            let committed = (self.samples / 160).saturating_sub(3);
            Ok(self.take(committed.max(self.read)))
        }

        fn finish(&mut self) -> Result<Frames, Failure> {
            Ok(self.take(self.samples / 160))
        }

        fn close(&mut self) {
            self.closes += 1;
        }
    }

    fn line(request: &Value, payload: &[u8]) -> Vec<u8> {
        let mut bytes = serde_json::to_vec(request).unwrap();
        bytes.push(b'\n');
        bytes.extend_from_slice(payload);
        bytes
    }

    fn run(worker: &mut Worker<Fake>, input: &[u8]) -> Vec<Value> {
        let mut output = Vec::new();
        serve(&mut Cursor::new(input), &mut output, worker).unwrap();
        String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn load() -> Value {
        json!({"op": "load", "id": 2, "runtime": "C:\\rt", "model": "C:\\m.gguf"})
    }

    fn audio(samples: usize) -> Vec<u8> {
        vec![0; samples * 2]
    }

    fn probs(response: &Value) -> Vec<f32> {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(response["probs"].as_str().unwrap())
            .unwrap();
        bytes
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect()
    }

    fn assert_failure(response: &Value, kind: &str) {
        assert_eq!(response["ok"], json!(false), "{response}");
        assert_eq!(response["kind"], json!(kind), "{response}");
        assert!(response["error"].as_str().is_some_and(|e| !e.is_empty()));
    }

    #[test]
    fn ping_names_the_process_and_the_processor() {
        let responses = run(
            &mut Worker::new(Fake::default()),
            b"{\"op\":\"ping\",\"id\":1}\n",
        );
        assert_eq!(responses[0]["id"], json!(1));
        assert_eq!(responses[0]["ok"], json!(true));
        assert_eq!(responses[0]["pid"], json!(std::process::id()));
        assert_eq!(responses[0]["version"], json!(env!("CARGO_PKG_VERSION")));
        assert_eq!(
            responses[0]["cpu"],
            serde_json::to_value(cpu::detect()).unwrap()
        );
    }

    #[test]
    fn load_uses_the_live_geometry_unless_told_otherwise() {
        let mut worker = Worker::new(Fake::default());
        let mut input = line(&load(), &[]);
        input.extend(line(
            &json!({"op": "load", "runtime": "r", "model": "m"}),
            &[],
        ));
        let responses = run(&mut worker, &input);
        assert_eq!(
            responses[0],
            json!({"id": 2, "ok": true, "speakers": 2, "secondsPerFrame": 0.01,
                   "loadMs": responses[0]["loadMs"], "runtimeVersion": "test"})
        );
        assert!(responses[0]["loadMs"].is_u64());
        assert_failure(&responses[1], "bad_request");
        assert_eq!(
            worker.backend.loads,
            [LoadRequest {
                runtime: "C:\\rt".into(),
                model: "C:\\m.gguf".into(),
                preset: "v3-streaming".into(),
                chunk_frames: 38,
                right_context_frames: 1,
            }]
        );

        let mut worker = Worker::new(Fake::default());
        run(
            &mut worker,
            &line(
                &json!({"op": "load", "runtime": "r", "model": "m", "preset": "v3-offline",
                        "chunkFrames": 0, "rightContextFrames": 2}),
                &[],
            ),
        );
        let request = &worker.backend.loads[0];
        assert_eq!(request.preset, "v3-offline");
        assert_eq!((request.chunk_frames, request.right_context_frames), (0, 2));
    }

    #[test]
    fn a_load_without_paths_or_with_a_bad_geometry_is_refused() {
        let mut worker = Worker::new(Fake::default());
        let mut input = Vec::new();
        for request in [
            json!({"op": "load", "model": "m"}),
            json!({"op": "load", "runtime": "", "model": "m"}),
            json!({"op": "load", "runtime": "r"}),
            json!({"op": "load", "runtime": "r", "model": "m", "chunkFrames": -1}),
            json!({"op": "load", "runtime": "r", "model": "m", "rightContextFrames": 2.5}),
            json!({"op": "load", "runtime": "r", "model": "m", "preset": 3}),
        ] {
            input.extend(line(&request, &[]));
        }
        for response in run(&mut worker, &input) {
            assert_failure(&response, "bad_request");
        }
        assert!(worker.backend.loads.is_empty());
    }

    #[test]
    fn a_failed_load_reports_its_kind_and_may_be_tried_again() {
        let mut worker = Worker::new(Fake {
            fail_load: Some(Failure::new(ErrorKind::Runtime, "No DLL.")),
            ..Fake::default()
        });
        let mut input = line(&load(), &[]);
        input.extend(line(&json!({"op": "open", "id": 3}), &[]));
        input.extend(line(&load(), &[]));
        let responses = run(&mut worker, &input);
        assert_eq!(
            responses[0],
            json!({"id": 2, "ok": false, "kind": "runtime", "error": "No DLL."})
        );
        assert_failure(&responses[1], "bad_request");
        assert_eq!(responses[2]["ok"], json!(true));
    }

    #[test]
    fn pushes_return_new_frames_that_continue_the_count() {
        let mut worker = Worker::new(Fake::default());
        let mut input = line(&load(), &[]);
        input.extend(line(&json!({"op": "open", "id": 3}), &[]));
        input.extend(line(
            &json!({"op": "push", "id": 4, "rate": 16000, "bytes": 3200}),
            &audio(1600),
        ));
        input.extend(line(
            &json!({"op": "push", "id": 5, "bytes": 3200}),
            &audio(1600),
        ));
        input.extend(line(&json!({"op": "finish", "id": 6}), &[]));
        input.extend(line(&json!({"op": "push", "id": 7, "bytes": 2}), &audio(1)));
        input.extend(line(&json!({"op": "finish", "id": 8}), &[]));
        let responses = run(&mut worker, &input);

        let first = &responses[2];
        assert_eq!(
            (
                &first["id"],
                &first["first"],
                &first["frames"],
                &first["count"]
            ),
            (&json!(4), &json!(0), &json!(7), &json!(7))
        );
        assert_eq!(
            probs(first),
            (0..7)
                .flat_map(|f| [f as f32, -(f as f32)])
                .collect::<Vec<_>>()
        );
        let second = &responses[3];
        assert_eq!(
            (&second["first"], &second["frames"], &second["count"]),
            (&json!(7), &json!(10), &json!(17))
        );
        assert_eq!(probs(second)[0], 7.0);
        let tail = &responses[4];
        assert_eq!(
            (&tail["first"], &tail["frames"], &tail["count"]),
            (&json!(17), &json!(3), &json!(20))
        );
        assert_failure(&responses[5], "not_open");
        assert_failure(&responses[6], "not_open");
    }

    #[test]
    fn a_push_with_no_new_frames_still_answers() {
        let mut worker = Worker::new(Fake::default());
        let mut input = line(&load(), &[]);
        input.extend(line(&json!({"op": "open"}), &[]));
        input.extend(line(&json!({"op": "push", "bytes": 200}), &audio(100)));
        let responses = run(&mut worker, &input);
        assert_eq!(
            responses[2],
            json!({"ok": true, "first": 0, "frames": 0, "count": 0, "probs": ""})
        );
    }

    #[test]
    fn pushing_needs_an_open_stream_and_well_formed_audio() {
        let mut worker = Worker::new(Fake::default());
        let mut input = line(&json!({"op": "open", "id": 1}), &[]);
        input.extend(line(&json!({"op": "push", "id": 2, "bytes": 4}), &audio(2)));
        input.extend(line(&load(), &[]));
        input.extend(line(&json!({"op": "push", "id": 3, "bytes": 4}), &audio(2)));
        input.extend(line(&json!({"op": "finish", "id": 4}), &[]));
        input.extend(line(&json!({"op": "open", "id": 5}), &[]));
        input.extend(line(&json!({"op": "push", "id": 6}), &[]));
        input.extend(line(
            &json!({"op": "push", "id": 7, "bytes": 3}),
            &[0, 0, 0],
        ));
        input.extend(line(
            &json!({"op": "push", "id": 8, "rate": 8000, "bytes": 2}),
            &audio(1),
        ));
        input.extend(line(&json!({"op": "close", "id": 9}), &[]));
        input.extend(line(
            &json!({"op": "push", "id": 10, "bytes": 2}),
            &audio(1),
        ));
        let responses = run(&mut worker, &input);

        assert_failure(&responses[0], "bad_request");
        assert_failure(&responses[1], "not_open");
        assert_failure(&responses[3], "not_open");
        assert_failure(&responses[4], "not_open");
        assert_eq!(responses[5], json!({"id": 5, "ok": true}));
        for response in &responses[6..9] {
            assert_failure(response, "bad_request");
        }
        assert_eq!(responses[9], json!({"id": 9, "ok": true}));
        assert_failure(&responses[10], "not_open");
        assert_eq!((worker.backend.opens, worker.backend.closes), (1, 1));
    }

    #[test]
    fn opening_again_starts_a_new_stream() {
        let mut worker = Worker::new(Fake::default());
        let mut input = line(&load(), &[]);
        input.extend(line(&json!({"op": "open"}), &[]));
        input.extend(line(&json!({"op": "push", "bytes": 3200}), &audio(1600)));
        input.extend(line(&json!({"op": "finish"}), &[]));
        input.extend(line(&json!({"op": "open"}), &[]));
        input.extend(line(&json!({"op": "push", "bytes": 3200}), &audio(1600)));
        let responses = run(&mut worker, &input);
        assert_eq!(responses[5]["first"], json!(0));
        assert_eq!(worker.backend.opens, 2);
    }

    #[test]
    fn unknown_ops_and_quit() {
        let mut worker = Worker::new(Fake::default());
        let responses = run(
            &mut worker,
            b"{\"op\":\"nope\",\"id\":5}\n{\"id\":6}\n{\"op\":7}\n{\"op\":\"quit\"}\n{\"op\":\"ping\"}\n",
        );
        assert_eq!(responses.len(), 3);
        assert!(responses[0]["error"].as_str().unwrap().contains("nope"));
        for response in &responses {
            assert_failure(response, "bad_request");
        }
    }
}
