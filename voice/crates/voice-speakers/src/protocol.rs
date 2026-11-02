//! Framing and message shapes of the worker protocol.
//!
//! The framing is a copy of voice-local's `src/protocol.rs`: voice-local is a binary crate, so its
//! module can't be shared as a library, and the two workers keep the same rules on purpose. A
//! request is one JSON object on one line. When it names `bytes`, exactly that many raw bytes
//! follow the newline. Every request gets one JSON line back, except `quit`.
//!
//! What differs from voice-local: the payload limit is 10 s of audio instead of an hour, and the
//! response fields and error kinds are this worker's.

use std::io::{self, BufRead, Read};

use serde::Serialize;
use serde_json::{Map, Value};

use crate::cpu::CpuFeatures;

/// Longest request line the worker reads. Requests are small; anything longer is a client bug or
/// audio that lost its framing.
pub const MAX_LINE: usize = 64 * 1024;

/// Largest payload the worker accepts: 10 s of 16 kHz mono 16-bit audio. The client pushes at
/// most 1 s at a time.
pub const MAX_PAYLOAD: u64 = 320_000;

/// One unit read from stdin.
#[derive(Debug)]
pub enum Frame {
    Request(Request),
    /// A line that isn't a usable request. Its payload, when its length was known, has been read
    /// and dropped, so the next frame starts at the next request.
    Invalid {
        id: Option<Value>,
        error: String,
    },
    /// Stdin closed between requests.
    End,
    /// Stdin closed inside a payload.
    Truncated {
        expected: u64,
        received: u64,
    },
}

#[derive(Debug)]
pub struct Request {
    pub fields: Map<String, Value>,
    /// Present exactly when the request named `bytes`.
    pub payload: Option<Vec<u8>>,
}

impl Request {
    pub fn id(&self) -> Option<Value> {
        self.fields.get("id").cloned()
    }

    pub fn str_field(&self, name: &str) -> Option<&str> {
        self.fields.get(name).and_then(Value::as_str)
    }

    /// The field's value, treating JSON `null` the same as a missing field.
    pub fn field(&self, name: &str) -> Option<&Value> {
        self.fields.get(name).filter(|value| !value.is_null())
    }
}

/// Reads the next request. Blank lines are skipped.
pub fn read_frame<R: BufRead>(input: &mut R) -> io::Result<Frame> {
    let mut line = Vec::new();
    loop {
        match read_line(input, &mut line)? {
            Line::End => return Ok(Frame::End),
            Line::TooLong => {
                return Ok(Frame::Invalid {
                    id: None,
                    error: format!("Request line is longer than {} KiB.", MAX_LINE / 1024),
                })
            }
            Line::Complete => {}
        }
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        return parse_request(input, &line);
    }
}

enum Line {
    Complete,
    TooLong,
    End,
}

fn read_line<R: BufRead>(input: &mut R, line: &mut Vec<u8>) -> io::Result<Line> {
    line.clear();
    let read = input
        .by_ref()
        .take(MAX_LINE as u64 + 1)
        .read_until(b'\n', line)?;
    if read == 0 {
        return Ok(Line::End);
    }
    if line.last() == Some(&b'\n') {
        line.pop();
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        return Ok(Line::Complete);
    }
    if line.len() > MAX_LINE {
        skip_to_newline(input)?;
        return Ok(Line::TooLong);
    }
    // A last line without a newline still counts, so `{"op":"quit"}` followed by EOF quits.
    Ok(Line::Complete)
}

fn skip_to_newline<R: BufRead>(input: &mut R) -> io::Result<()> {
    loop {
        let buffer = input.fill_buf()?;
        if buffer.is_empty() {
            return Ok(());
        }
        if let Some(at) = buffer.iter().position(|&byte| byte == b'\n') {
            input.consume(at + 1);
            return Ok(());
        }
        let len = buffer.len();
        input.consume(len);
    }
}

fn parse_request<R: BufRead>(input: &mut R, line: &[u8]) -> io::Result<Frame> {
    let fields = match serde_json::from_slice::<Value>(line) {
        Ok(Value::Object(fields)) => fields,
        Ok(_) => return Ok(invalid(None, "Request is not a JSON object.")),
        Err(_) => return Ok(invalid(None, "Request is not valid JSON.")),
    };
    let id = fields.get("id").cloned();
    let Some(bytes) = fields.get("bytes") else {
        return Ok(Frame::Request(Request {
            fields,
            payload: None,
        }));
    };
    let Some(expected) = bytes.as_u64() else {
        // Without a usable length the payload can't be skipped; whatever follows is read as lines.
        return Ok(invalid(id, "bytes must be a whole number of bytes."));
    };
    if expected > MAX_PAYLOAD {
        let received = io::copy(&mut input.by_ref().take(expected), &mut io::sink())?;
        if received < expected {
            return Ok(Frame::Truncated { expected, received });
        }
        return Ok(invalid(
            id,
            "Audio is longer than 10 seconds; push at most 10 seconds at a time.",
        ));
    }
    let mut payload = Vec::with_capacity(expected as usize);
    input.by_ref().take(expected).read_to_end(&mut payload)?;
    if (payload.len() as u64) < expected {
        return Ok(Frame::Truncated {
            expected,
            received: payload.len() as u64,
        });
    }
    Ok(Frame::Request(Request {
        fields,
        payload: Some(payload),
    }))
}

fn invalid(id: Option<Value>, error: &str) -> Frame {
    Frame::Invalid {
        id,
        error: error.to_owned(),
    }
}

/// Error kinds the client can act on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    /// The request itself is wrong: framing, an unknown op, a bad field or the wrong order.
    BadRequest,
    /// The processor lacks a feature the portable runtime needs. Nothing native was loaded.
    Cpu,
    /// The runtime folder, its DLL or one of its exports is missing, or the DLL didn't load.
    Runtime,
    /// The runtime refused the model.
    Model,
    /// `push` or `finish` without an open stream, or after `finish`.
    NotOpen,
    /// The runtime already dropped frames this worker hadn't returned yet.
    Behind,
    /// Anything else the runtime reported.
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    pub kind: ErrorKind,
    pub message: String,
}

impl Failure {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::BadRequest, message)
    }
}

/// One response line. Fields that don't apply to the op are left out.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<Value>,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu: Option<CpuFeatures>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speakers: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seconds_per_frame: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub load_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frames: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub probs: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<ErrorKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Response {
    pub fn ok() -> Self {
        Self {
            ok: true,
            ..Self::default()
        }
    }

    pub fn failure(failure: Failure) -> Self {
        Self {
            ok: false,
            kind: Some(failure.kind),
            error: Some(failure.message),
            ..Self::default()
        }
    }

    pub fn with_id(mut self, id: Option<Value>) -> Self {
        self.id = id;
        self
    }

    /// The response as one line, newline included.
    pub fn to_line(&self) -> Vec<u8> {
        let mut line = serde_json::to_vec(self).expect("a response always serializes");
        line.push(b'\n');
        line
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;

    fn frames(input: &[u8]) -> Vec<Frame> {
        let mut cursor = Cursor::new(input);
        let mut frames = Vec::new();
        loop {
            let frame = read_frame(&mut cursor).unwrap();
            let done = matches!(frame, Frame::End | Frame::Truncated { .. });
            frames.push(frame);
            if done {
                return frames;
            }
        }
    }

    fn op(frame: &Frame) -> &str {
        match frame {
            Frame::Request(request) => request.str_field("op").unwrap(),
            other => panic!("expected a request, got {other:?}"),
        }
    }

    #[test]
    fn reads_lines_and_payloads_in_order() {
        let mut input = b"{\"op\":\"ping\"}\r\n\n  \n".to_vec();
        input.extend_from_slice(b"{\"op\":\"push\",\"id\":3,\"bytes\":4}\n");
        input.extend_from_slice(&[1, 0, b'\n', 0]);
        input.extend_from_slice(b"{\"op\":\"quit\"}");

        let frames = frames(&input);
        assert_eq!(frames.len(), 4);
        assert_eq!(op(&frames[0]), "ping");
        assert_eq!(op(&frames[1]), "push");
        let Frame::Request(push) = &frames[1] else {
            unreachable!()
        };
        assert_eq!(push.payload.as_deref(), Some(&[1, 0, b'\n', 0][..]));
        assert_eq!(push.id(), Some(json!(3)));
        assert_eq!(op(&frames[2]), "quit");
        assert!(matches!(frames[3], Frame::End));
    }

    #[test]
    fn malformed_lines_are_reported_and_reading_goes_on() {
        let frames = frames(b"not json\n[1,2]\n{\"op\":\"ping\"}\n");
        assert!(
            matches!(&frames[0], Frame::Invalid { id: None, error } if error.contains("not valid JSON"))
        );
        assert!(
            matches!(&frames[1], Frame::Invalid { error, .. } if error.contains("not a JSON object"))
        );
        assert_eq!(op(&frames[2]), "ping");
    }

    #[test]
    fn a_payload_that_ends_early_is_truncated() {
        let frames = frames(b"{\"op\":\"push\",\"bytes\":10}\nabc");
        assert!(matches!(
            frames[0],
            Frame::Truncated {
                expected: 10,
                received: 3
            }
        ));
    }

    #[test]
    fn a_too_long_line_is_skipped_up_to_its_newline() {
        let mut input = vec![b'x'; MAX_LINE + 10];
        input.extend_from_slice(b"\n{\"op\":\"ping\"}\n");
        let frames = frames(&input);
        assert!(
            matches!(&frames[0], Frame::Invalid { error, .. } if error.contains("longer than"))
        );
        assert_eq!(op(&frames[1]), "ping");
    }

    #[test]
    fn ten_seconds_is_the_largest_payload() {
        let mut input =
            format!("{{\"op\":\"push\",\"id\":1,\"bytes\":{MAX_PAYLOAD}}}\n").into_bytes();
        input.resize(input.len() + MAX_PAYLOAD as usize, 0);
        let header = format!(
            "{{\"op\":\"push\",\"id\":2,\"bytes\":{}}}\n",
            MAX_PAYLOAD + 2
        );
        input.extend_from_slice(header.as_bytes());
        input.resize(input.len() + MAX_PAYLOAD as usize + 2, 0);
        input.extend_from_slice(b"{\"op\":\"ping\"}\n");

        let frames = frames(&input);
        assert_eq!(op(&frames[0]), "push");
        assert!(
            matches!(&frames[1], Frame::Invalid { id: Some(id), error } if *id == json!(2) && error.contains("longer than 10 seconds"))
        );
        assert_eq!(op(&frames[2]), "ping");
    }

    #[test]
    fn responses_are_single_camel_case_lines() {
        let mut response = Response::ok().with_id(Some(json!(7)));
        response.seconds_per_frame = Some(0.01);
        response.load_ms = Some(812);
        assert_eq!(
            String::from_utf8(response.to_line()).unwrap(),
            "{\"id\":7,\"ok\":true,\"secondsPerFrame\":0.01,\"loadMs\":812}\n"
        );

        let failure = Response::failure(Failure::new(ErrorKind::NotOpen, "No stream."));
        assert_eq!(
            String::from_utf8(failure.to_line()).unwrap(),
            "{\"ok\":false,\"kind\":\"not_open\",\"error\":\"No stream.\"}\n"
        );
    }
}
