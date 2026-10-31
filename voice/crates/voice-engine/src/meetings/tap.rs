//! Dictation's microphone during a meeting: the recorder's `tap` of the `mic` track, so the
//! microphone is captured once for both (decision 9).

use std::io::Read;
use std::net::{Shutdown, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde_json::json;
use voice_recorder::control::Client;
use voice_recorder::meeting::RecorderFile;

use crate::meetings::controller;
use crate::services::{AudioSink, MicStream};

/// Reads 10 ms at a time, as the recorder sends it.
const BLOCK_BYTES: usize = 320;

/// What runs when the recorder ends the tap: the meeting stopped or its recorder died.
pub type TapEnd = Box<dyn FnOnce() + Send>;

pub struct Tap {
    socket: TcpStream,
    /// Set when Voice closes the tap itself, which isn't an end to report.
    closing: Arc<AtomicBool>,
    reader: Option<JoinHandle<()>>,
}

impl MicStream for Tap {}

impl Drop for Tap {
    fn drop(&mut self) {
        self.closing.store(true, Ordering::SeqCst);
        let _ = self.socket.shutdown(Shutdown::Both);
        if let Some(reader) = self.reader.take() {
            // The end callback may replace the tap from the reader thread itself.
            if reader.thread().id() != thread::current().id() {
                let _ = reader.join();
            }
        }
    }
}

/// Tells the recorder whether the user dictates on its microphone (decision 9): `start` or
/// `end`. Fails unless the recorder answered yes.
pub fn dictation(file: &RecorderFile, state: &str) -> Result<(), String> {
    let reply = controller::request(
        file,
        json!({"cmd": "dictation", "state": state}),
        Duration::from_secs(2),
    )
    .map_err(|e| format!("The recorder didn't answer: {e}"))?;
    if reply["ok"] == true {
        Ok(())
    } else {
        Err(format!(
            "The recorder refused: {}",
            reply["error"].as_str().unwrap_or("unexpected answer")
        ))
    }
}

/// Opens the tap; blocks until the recorder said yes or no.
pub fn open(file: &RecorderFile, on_audio: AudioSink) -> Result<Tap, String> {
    open_until(file, on_audio, Box::new(|| {}))
}

/// [`open`], with `on_end` run on the reader thread when the recorder ends the tap: the meeting
/// stopped or its recorder died. It doesn't run when Voice drops the tap.
pub fn open_until(
    file: &RecorderFile,
    mut on_audio: AudioSink,
    on_end: TapEnd,
) -> Result<Tap, String> {
    let mut client = Client::connect(file.port, Duration::from_secs(1))
        .map_err(|e| format!("The meeting's microphone isn't reachable: {e}"))?;
    let reply = client
        .request(&json!({"token": file.token, "cmd": "tap", "track": "mic"}))
        .map_err(|e| format!("The recorder didn't answer: {e}"))?;
    if reply["ok"] != true || reply["rate"] != 16_000 {
        return Err(format!(
            "The recorder refused the microphone tap: {}",
            reply["error"].as_str().unwrap_or("unexpected answer")
        ));
    }
    let mut pcm = client.into_pcm();
    let socket = pcm
        .get_ref()
        .try_clone()
        .map_err(|e| format!("The meeting's microphone isn't readable: {e}"))?;
    socket
        .set_read_timeout(None)
        .map_err(|e| format!("The meeting's microphone isn't readable: {e}"))?;
    let closing = Arc::new(AtomicBool::new(false));
    let closed = Arc::clone(&closing);
    let reader = thread::Builder::new()
        .name("dictation-tap".into())
        .spawn(move || {
            let mut bytes = [0u8; BLOCK_BYTES];
            // An odd byte waits for its partner in the next read.
            let mut carry: Option<u8> = None;
            let mut samples = Vec::with_capacity(BLOCK_BYTES / 2 + 1);
            loop {
                let n = match pcm.read(&mut bytes) {
                    Ok(0) | Err(_) => {
                        if !closed.load(Ordering::SeqCst) {
                            on_end();
                        }
                        return;
                    }
                    Ok(n) => n,
                };
                samples.clear();
                let mut data = &bytes[..n];
                if let Some(low) = carry.take() {
                    samples.push(i16::from_le_bytes([low, data[0]]));
                    data = &data[1..];
                }
                let mut pairs = data.chunks_exact(2);
                samples.extend(pairs.by_ref().map(|p| i16::from_le_bytes([p[0], p[1]])));
                carry = pairs.remainder().first().copied();
                if !samples.is_empty() {
                    on_audio(&samples);
                }
            }
        })
        .map_err(|e| format!("Couldn't start reading the microphone: {e}"))?;
    Ok(Tap {
        socket,
        closing,
        reader: Some(reader),
    })
}
