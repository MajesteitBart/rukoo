//! Mistral's realtime transcription (`voxtral-mini-transcribe-realtime-*`) over a WebSocket.
//!
//! One session per track. Voice sends `session.update` before any audio, then
//! `input_audio.append` with base64 s16le PCM at 16 kHz, then `input_audio.end`. Mistral answers
//! with `transcription.text.delta`, or `transcription.segment` with a `speaker_id` when `diarize`
//! is on, and ends with `transcription.done`. `session.*` and `turn.*` events carry nothing Voice
//! uses.
//!
//! The socket is blocking. `poll` waits on it with a read timeout, so the follower thread that
//! owns a stream needs no async runtime. TLS is rustls with the webpki roots, as ureq uses.

use std::fmt;
use std::io;
use std::net::{Ipv4Addr, Shutdown, SocketAddr, TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde_json::{json, Map, Value};
use tungstenite::client::IntoClientRequest;
use tungstenite::error::ProtocolError;
use tungstenite::http::header::{HeaderValue, AUTHORIZATION, USER_AGENT};
use tungstenite::protocol::CloseFrame;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Error as WsError, HandshakeError, Message, WebSocket};

use super::http::{network_error, timeout_error};
use super::stream::{SpeechStream, StreamEvent, StreamSession, StreamingSpeech};
use super::urls::{quote, split};
use super::{
    audio_settings_page, describe_api_error, redacted, ErrorKind, ProviderConfig, ProviderError,
    Purpose,
};

const LABEL: &str = "Mistral";

/// How long Voice waits for the connection, the handshake, `session.updated` and each write.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Mistral's default streaming delay, used when a session asks for none.
pub const DEFAULT_DELAY_MS: u32 = 480;

/// Mistral accepts at most eight `speaker_references`.
const MAX_REFERENCES: usize = 8;

/// The read timeout while collecting messages that already arrived after the first.
const DRAIN: Duration = Duration::from_millis(1);

/// How long a failed write looks for an `error` event that explains it.
const WRITE_FAILURE_READ: Duration = Duration::from_millis(200);

/// The `target_streaming_delay_ms` Voice sends for a requested delay. Mistral only takes the
/// values its model was trained on, 80 to 1200 ms or 2400 ms, and refuses others with an error
/// event. Voice rounds to a multiple of 80 ms in that range; 0 means the default, 480 ms.
pub fn streaming_delay_ms(requested: u32) -> u32 {
    match requested {
        0 => DEFAULT_DELAY_MS,
        1800.. => 2400,
        ms => (ms.saturating_add(40) / 80 * 80).clamp(80, 1200),
    }
}

/// The socket URL for a meeting endpoint: `https` becomes `wss`, the path gets `/realtime` and the
/// query `model=<model>`. `ws://` only for a loopback host.
pub fn realtime_url(endpoint: &str, model: &str) -> Result<String, ProviderError> {
    let endpoint = endpoint.trim();
    let model = model.trim();
    let page = audio_settings_page(Purpose::Meetings);
    if endpoint.is_empty() {
        return Err(ProviderError::config(format!(
            "Choose an audio endpoint in {page}."
        )));
    }
    if model.is_empty() {
        return Err(ProviderError::config("Select an audio model in Settings."));
    }
    let invalid = || {
        ProviderError::config(format!(
            "This endpoint isn't a valid web address: {endpoint}"
        ))
    };
    let parts = split(endpoint);
    let host = parts.hostname();
    if host.is_empty() || host.contains(['/', '\\', ' ']) {
        return Err(invalid());
    }
    let port = match parts.port() {
        Some(port) => Some(port.parse::<u16>().map_err(|_| invalid())?),
        None => None,
    };
    let scheme = match parts.scheme.to_ascii_lowercase().as_str() {
        "https" | "wss" => "wss",
        "http" | "ws" if is_loopback(&host) => "ws",
        "http" | "ws" => {
            return Err(ProviderError::config(format!(
                "Mistral's realtime stream needs a secure connection. Use an https:// address for {host} in {page}."
            )))
        }
        _ => return Err(invalid()),
    };
    let mut path = parts.path.trim_end_matches('/').to_string();
    if !path.ends_with("/realtime") {
        path.push_str("/realtime");
    }
    let host = if host.contains(':') {
        format!("[{host}]")
    } else {
        host
    };
    let netloc = match port {
        Some(port) => format!("{host}:{port}"),
        None => host,
    };
    Ok(format!(
        "{scheme}://{netloc}{path}?model={}",
        quote(model, "")
    ))
}

/// Hosts that never leave this computer: the only ones allowed an unencrypted socket.
fn is_loopback(host: &str) -> bool {
    host == "localhost"
        || host == "::1"
        || host
            .parse::<Ipv4Addr>()
            .is_ok_and(|address| address.is_loopback())
}

/// A meeting provider config for Mistral's realtime model. The key never appears in `Debug` or
/// in errors.
pub struct MistralRealtime {
    endpoint: String,
    model: String,
    api_key: String,
    connect_timeout: Duration,
}

impl fmt::Debug for MistralRealtime {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MistralRealtime")
            .field("endpoint", &self.endpoint)
            .field("model", &self.model)
            .field("api_key", &redacted(&self.api_key))
            .field("connect_timeout", &self.connect_timeout)
            .finish()
    }
}

impl MistralRealtime {
    /// A config error without a key, a model or a usable endpoint.
    pub fn new(cfg: &ProviderConfig) -> Result<MistralRealtime, ProviderError> {
        realtime_url(&cfg.endpoint, &cfg.model)?;
        if cfg.api_key.trim().is_empty() {
            return Err(ProviderError::config(format!(
                "No API key set for meeting transcription. Open {} and add a key.",
                audio_settings_page(Purpose::Meetings)
            )));
        }
        Ok(MistralRealtime {
            endpoint: cfg.endpoint.trim().to_string(),
            model: cfg.model.trim().to_string(),
            api_key: cfg.api_key.trim().to_string(),
            connect_timeout: CONNECT_TIMEOUT,
        })
    }

    /// Replaces [`CONNECT_TIMEOUT`], for tests.
    pub fn with_timeout(mut self, timeout: Duration) -> MistralRealtime {
        self.connect_timeout = timeout.max(Duration::from_millis(1));
        self
    }

    /// Opens a session: connects, sends `session.update` and waits for `session.updated`.
    pub fn open(&self, session: &StreamSession) -> Result<MistralStream, ProviderError> {
        self.open_inner(session).map_err(|error| self.scrub(error))
    }

    fn open_inner(&self, session: &StreamSession) -> Result<MistralStream, ProviderError> {
        let url = realtime_url(&self.endpoint, &self.model)?;
        let page = audio_settings_page(Purpose::Meetings);
        let mut request = url.as_str().into_client_request().map_err(|_| {
            ProviderError::config(format!(
                "This endpoint isn't a valid web address: {}",
                self.endpoint
            ))
        })?;
        let mut auth = HeaderValue::from_str(&format!("Bearer {}", self.api_key)).map_err(|_| {
            ProviderError::config(format!(
                "The API key for meeting transcription has characters that can't be sent. Check it in {page}."
            ))
        })?;
        auth.set_sensitive(true);
        request.headers_mut().insert(AUTHORIZATION, auth);
        request.headers_mut().insert(
            USER_AGENT,
            HeaderValue::from_static(concat!("rukoo-voice/", env!("CARGO_PKG_VERSION"))),
        );

        let tcp = self.tcp(&url)?;
        let _ = tcp.set_nodelay(true);
        // Set on this handle: on Windows a timeout set through a `try_clone` handle doesn't
        // reach reads on the original.
        tcp.set_read_timeout(Some(self.connect_timeout))
            .and_then(|()| tcp.set_write_timeout(Some(self.connect_timeout)))
            .map_err(|_| network_error(&url))?;
        let ws = match tungstenite::client_tls_with_config(request, tcp, None, None) {
            Ok((ws, _response)) => ws,
            Err(HandshakeError::Failure(error)) => return Err(self.handshake_error(error, &url)),
            // A read timeout during the handshake shows up as an interrupted handshake on Unix.
            Err(HandshakeError::Interrupted(_)) => {
                return Err(timeout_error(LABEL, self.connect_timeout))
            }
        };
        let mut stream = MistralStream {
            ws,
            url,
            timeout: self.connect_timeout,
            queued: Vec::new(),
            failed: None,
            ended: false,
            done: false,
            closed: false,
        };
        stream.send(session_update(session))?;

        let deadline = Instant::now() + self.connect_timeout;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(timeout_error(LABEL, self.connect_timeout));
            }
            let mut received = Vec::new();
            stream.read_into(&mut received, left);
            if let Some(error) = received
                .iter()
                .find(|message| event_type(message) == "error")
            {
                return Err(event_error(error));
            }
            let updated = received
                .iter()
                .any(|message| event_type(message) == "session.updated");
            stream.queued.extend(received);
            if updated {
                return Ok(stream);
            }
            if let Some(error) = &stream.failed {
                return Err(error.clone());
            }
        }
    }

    fn tcp(&self, url: &str) -> Result<TcpStream, ProviderError> {
        let parts = split(url);
        let host = parts.hostname();
        let port = parts
            .port()
            .and_then(|port| port.parse::<u16>().ok())
            .unwrap_or(if parts.scheme == "wss" { 443 } else { 80 });
        let addresses: Vec<SocketAddr> = (host.as_str(), port)
            .to_socket_addrs()
            .map_err(|_| network_error(url))?
            .collect();
        let mut timed_out = false;
        for address in &addresses {
            match TcpStream::connect_timeout(address, self.connect_timeout) {
                Ok(stream) => return Ok(stream),
                Err(error) => timed_out |= is_timeout(&error),
            }
        }
        Err(if timed_out {
            timeout_error(LABEL, self.connect_timeout)
        } else {
            network_error(url)
        })
    }

    fn handshake_error(&self, error: WsError, url: &str) -> ProviderError {
        match error {
            WsError::Http(response) => {
                let status = response.status();
                let body = response
                    .body()
                    .as_deref()
                    .map(String::from_utf8_lossy)
                    .unwrap_or_default();
                let kind = match status.as_u16() {
                    401 | 403 => ErrorKind::Auth,
                    _ => ErrorKind::Provider,
                };
                ProviderError::new(
                    kind,
                    describe_api_error(Some(status.as_u16()), status.canonical_reason(), &body),
                )
            }
            WsError::Url(_) | WsError::HttpFormat(_) => ProviderError::config(format!(
                "This endpoint isn't a valid web address: {}",
                self.endpoint
            )),
            other => transport_error(other, url, self.connect_timeout),
        }
    }

    /// Belt and braces: no message Voice builds holds the key, but a server could echo it.
    fn scrub(&self, mut error: ProviderError) -> ProviderError {
        if !self.api_key.is_empty() && error.message.contains(&self.api_key) {
            error.message = error.message.replace(&self.api_key, "<redacted>");
        }
        error
    }
}

impl StreamingSpeech for MistralRealtime {
    fn connect(&self, session: &StreamSession) -> Result<Box<dyn SpeechStream>, ProviderError> {
        Ok(Box::new(self.open(session)?))
    }
}

/// The `session.update` message: audio format, delay, diarization, language, dictionary and the
/// reference clips. References need `diarize`, so they go only with it.
fn session_update(session: &StreamSession) -> Value {
    let mut fields = Map::new();
    fields.insert(
        "audio_format".into(),
        json!({"encoding": "pcm_s16le", "sample_rate": 16_000}),
    );
    fields.insert(
        "target_streaming_delay_ms".into(),
        json!(streaming_delay_ms(session.delay_ms)),
    );
    fields.insert("diarize".into(), json!(session.diarize));
    if let Some(language) = session
        .language
        .as_deref()
        .map(str::trim)
        .filter(|code| !code.is_empty() && !code.eq_ignore_ascii_case("auto"))
    {
        fields.insert("language".into(), json!(language));
    }
    let bias: Vec<&str> = session
        .context_bias
        .iter()
        .map(|term| term.trim())
        .filter(|term| !term.is_empty())
        .collect();
    if !bias.is_empty() {
        fields.insert("context_bias".into(), json!(bias));
    }
    if session.diarize && !session.references.is_empty() {
        let references: Map<String, Value> = session
            .references
            .iter()
            .take(MAX_REFERENCES)
            .map(|(name, wav)| (name.clone(), Value::String(base64_text(wav))))
            .collect();
        fields.insert("speaker_references".into(), Value::Object(references));
    }
    json!({"type": "session.update", "session": fields})
}

fn base64_text(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// One open realtime session. Owned by one thread.
pub struct MistralStream {
    ws: WebSocket<MaybeTlsStream<TcpStream>>,
    url: String,
    timeout: Duration,
    /// Messages read but not yet handed out, such as `session.created` during `open`.
    queued: Vec<Value>,
    /// Sticky: once the session failed, every later call returns this.
    failed: Option<ProviderError>,
    /// `input_audio.end` was sent.
    ended: bool,
    /// `transcription.done` arrived.
    done: bool,
    /// The socket closed after `transcription.done`.
    closed: bool,
}

impl fmt::Debug for MistralStream {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MistralStream")
            .field("url", &self.url)
            .field("ended", &self.ended)
            .field("done", &self.done)
            .field("closed", &self.closed)
            .field("failed", &self.failed)
            .finish()
    }
}

impl MistralStream {
    /// Every message received so far, as Mistral sent it, `session.*`, `turn.*` and `error`
    /// included. Waits at most `wait` for the first. Only a failed connection is an `Err`, and
    /// only once the messages before the failure were handed out.
    pub fn poll_raw(&mut self, wait: Duration) -> Result<Vec<Value>, ProviderError> {
        let mut messages = std::mem::take(&mut self.queued);
        let wait = if messages.is_empty() {
            wait
        } else {
            Duration::ZERO
        };
        self.read_into(&mut messages, wait);
        match &self.failed {
            Some(error) if messages.is_empty() => Err(error.clone()),
            _ => Ok(messages),
        }
    }

    /// Whether `transcription.done` arrived.
    pub fn is_done(&self) -> bool {
        self.done
    }

    /// The TCP socket under the WebSocket and its TLS layer.
    fn socket(&self) -> Option<&TcpStream> {
        match self.ws.get_ref() {
            MaybeTlsStream::Plain(socket) => Some(socket),
            MaybeTlsStream::Rustls(tls) => Some(&tls.sock),
            _ => None,
        }
    }

    fn set_read_timeout(&self, timeout: Duration) -> io::Result<()> {
        match self.socket() {
            Some(socket) => socket.set_read_timeout(Some(timeout)),
            None => Err(io::Error::from(io::ErrorKind::Unsupported)),
        }
    }

    /// Reads whole messages into `out` until `wait` passes without one, or, once one arrived,
    /// until no more are waiting. A failure is stored in `failed`.
    fn read_into(&mut self, out: &mut Vec<Value>, wait: Duration) {
        if self.failed.is_some() || self.closed {
            return;
        }
        let deadline = Instant::now() + wait;
        loop {
            let left = if out.is_empty() {
                deadline.saturating_duration_since(Instant::now())
            } else {
                Duration::ZERO
            };
            if self.set_read_timeout(left.max(DRAIN)).is_err() {
                self.failed = Some(network_error(&self.url));
                return;
            }
            match self.ws.read() {
                Ok(Message::Text(text)) => {
                    // Anything that isn't JSON isn't one of Mistral's events.
                    if let Ok(message) = serde_json::from_str::<Value>(text.as_str()) {
                        if event_type(&message) == "transcription.done" {
                            self.done = true;
                        }
                        out.push(message);
                    }
                }
                Ok(Message::Close(frame)) => {
                    self.closed_by_server(frame);
                    return;
                }
                Ok(_) => {}
                Err(WsError::Io(error)) if is_timeout(&error) => {
                    if !out.is_empty() || Instant::now() >= deadline {
                        return;
                    }
                }
                Err(
                    WsError::ConnectionClosed
                    | WsError::AlreadyClosed
                    | WsError::Protocol(ProtocolError::ResetWithoutClosingHandshake),
                ) => {
                    self.closed_by_server(None);
                    return;
                }
                Err(error) => {
                    self.failed = Some(transport_error(error, &self.url, self.timeout));
                    return;
                }
            }
        }
    }

    fn closed_by_server(&mut self, frame: Option<CloseFrame>) {
        if self.done {
            self.closed = true;
            return;
        }
        let reason = frame
            .map(|frame| crate::cleanup::collapse_whitespace(frame.reason.as_str()))
            .filter(|reason| !reason.is_empty());
        self.failed = Some(match reason {
            Some(reason) => {
                ProviderError::provider(format!("Mistral closed the stream: {}", shorten(&reason)))
            }
            None => ProviderError::new(
                ErrorKind::Network,
                "Mistral closed the stream before it finished.",
            ),
        });
    }

    fn send(&mut self, message: Value) -> Result<(), ProviderError> {
        if let Some(error) = &self.failed {
            return Err(error.clone());
        }
        let Err(error) = self.ws.send(Message::text(message.to_string())) else {
            return Ok(());
        };
        let mut error = transport_error(error, &self.url, self.timeout);
        // Mistral sends an `error` event before it drops a session; that says more than the
        // broken socket.
        let mut received = Vec::new();
        self.read_into(&mut received, WRITE_FAILURE_READ);
        if let Some(reason) = received
            .iter()
            .find(|message| event_type(message) == "error")
        {
            error = event_error(reason);
        }
        self.queued.extend(received);
        self.failed = Some(error.clone());
        Err(error)
    }
}

impl SpeechStream for MistralStream {
    fn push(&mut self, pcm: &[i16]) -> Result<(), ProviderError> {
        if let Some(error) = &self.failed {
            return Err(error.clone());
        }
        if self.ended {
            return Err(ProviderError::provider(
                "The realtime stream already ended.",
            ));
        }
        if pcm.is_empty() {
            return Ok(());
        }
        let mut bytes = Vec::with_capacity(pcm.len() * 2);
        for sample in pcm {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        self.send(json!({"type": "input_audio.append", "audio": base64_text(&bytes)}))
    }

    fn poll(&mut self, wait: Duration) -> Result<Vec<StreamEvent>, ProviderError> {
        let messages = self.poll_raw(wait)?;
        let mut events = Vec::new();
        for message in &messages {
            match parse_realtime_event(message) {
                Ok(Some(event)) => events.push(event),
                Ok(None) => {}
                // The events before it still count; the error comes with the next call.
                Err(error) => {
                    self.failed = Some(error);
                    break;
                }
            }
        }
        match &self.failed {
            Some(error) if events.is_empty() => Err(error.clone()),
            _ => Ok(events),
        }
    }

    fn end(&mut self) -> Result<(), ProviderError> {
        if let Some(error) = &self.failed {
            return Err(error.clone());
        }
        if self.ended {
            return Ok(());
        }
        self.send(json!({"type": "input_audio.end"}))?;
        self.ended = true;
        Ok(())
    }
}

impl Drop for MistralStream {
    fn drop(&mut self) {
        if self.failed.is_none() && !self.closed {
            if let Some(socket) = self.socket() {
                let _ = socket.set_write_timeout(Some(Duration::from_millis(500)));
            }
            let _ = self.ws.close(None);
            let _ = self.ws.flush();
        }
        if let Some(socket) = self.socket() {
            let _ = socket.shutdown(Shutdown::Both);
        }
    }
}

/// One server message as a stream event: `transcription.segment` and non-empty
/// `transcription.text.delta` become [`StreamEvent::Segment`], `transcription.done` becomes
/// [`StreamEvent::Done`], `error` becomes an `Err`, and everything else `None`.
pub fn parse_realtime_event(message: &Value) -> Result<Option<StreamEvent>, ProviderError> {
    let text = || {
        message
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    match event_type(message) {
        "transcription.segment" => {
            let text = text();
            if text.is_empty() {
                return Ok(None);
            }
            let speaker = match message.get("speaker_id") {
                Some(Value::String(id)) => Some(id.trim().to_string()).filter(|id| !id.is_empty()),
                Some(Value::Number(id)) => Some(id.to_string()),
                _ => None,
            };
            Ok(Some(StreamEvent::Segment {
                text,
                speaker,
                start: message.get("start").and_then(Value::as_f64),
                end: message.get("end").and_then(Value::as_f64),
            }))
        }
        "transcription.text.delta" => {
            let text = text();
            Ok((!text.is_empty()).then_some(StreamEvent::Segment {
                text,
                speaker: None,
                start: None,
                end: None,
            }))
        }
        "transcription.done" => Ok(Some(StreamEvent::Done)),
        "error" => Err(event_error(message)),
        _ => Ok(None),
    }
}

fn event_type(message: &Value) -> &str {
    message.get("type").and_then(Value::as_str).unwrap_or("")
}

/// An `error` event as a provider error with Mistral's own message.
fn event_error(message: &Value) -> ProviderError {
    let (text, code) = match message.get("error") {
        Some(Value::Object(detail)) => (message_text(detail.get("message")), detail.get("code")),
        Some(Value::String(text)) => (text.clone(), message.get("code")),
        _ => (message_text(message.get("message")), message.get("code")),
    };
    let text = crate::cleanup::collapse_whitespace(&text);
    let text = if text.is_empty() {
        "no reason given".to_string()
    } else {
        shorten(&text)
    };
    let code = code.and_then(|code| match code {
        Value::Number(number) => number.as_u64(),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    });
    match code {
        Some(status @ 100..=599) => {
            let kind = match status {
                401 | 403 => ErrorKind::Auth,
                _ => ErrorKind::Provider,
            };
            ProviderError::new(kind, format!("API error {status}: {text}"))
        }
        _ => ProviderError::provider(format!("Mistral's realtime transcription failed: {text}")),
    }
}

fn message_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        None | Some(Value::Null) => String::new(),
        Some(other) => other.to_string(),
    }
}

/// At most 220 characters, as `describe_api_error` keeps.
fn shorten(text: &str) -> String {
    text.chars().take(220).collect()
}

fn is_timeout(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
    )
}

fn transport_error(error: WsError, url: &str, timeout: Duration) -> ProviderError {
    match error {
        WsError::Io(error) if is_timeout(&error) => timeout_error(LABEL, timeout),
        WsError::Io(_) | WsError::Tls(_) => network_error(url),
        WsError::ConnectionClosed
        | WsError::AlreadyClosed
        | WsError::Protocol(ProtocolError::ResetWithoutClosingHandshake) => ProviderError::new(
            ErrorKind::Network,
            "Mistral closed the stream before it finished.",
        ),
        other => ProviderError::provider(format!("The stream to {LABEL} failed: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_update_carries_every_field() {
        let session = StreamSession {
            diarize: true,
            language: Some(" nl ".into()),
            context_bias: vec!["Rukoo".into(), "  ".into()],
            delay_ms: 500,
            references: vec![("call-1".into(), vec![1, 2, 3])],
        };
        let message = session_update(&session);
        assert_eq!(message["type"], "session.update");
        let fields = &message["session"];
        assert_eq!(
            fields["audio_format"],
            json!({"encoding": "pcm_s16le", "sample_rate": 16000})
        );
        assert_eq!(fields["target_streaming_delay_ms"], 480);
        assert_eq!(fields["diarize"], true);
        assert_eq!(fields["language"], "nl");
        assert_eq!(fields["context_bias"], json!(["Rukoo"]));
        assert_eq!(fields["speaker_references"], json!({"call-1": "AQID"}));
        assert!(fields.get("turn_detection").is_none());
    }

    #[test]
    fn session_update_leaves_out_what_isnt_set() {
        let session = StreamSession {
            language: Some("auto".into()),
            references: vec![("call-1".into(), vec![0; 4])],
            ..StreamSession::default()
        };
        let fields = session_update(&session)["session"].clone();
        assert_eq!(fields["target_streaming_delay_ms"], DEFAULT_DELAY_MS);
        assert_eq!(fields["diarize"], false);
        assert!(fields.get("language").is_none());
        assert!(fields.get("context_bias").is_none());
        // References need diarization, so a session without it never sends them.
        assert!(fields.get("speaker_references").is_none());
    }

    #[test]
    fn at_most_eight_references() {
        let session = StreamSession {
            diarize: true,
            references: (1..=10)
                .map(|n| (format!("call-{n}"), vec![0; 2]))
                .collect(),
            ..StreamSession::default()
        };
        let fields = session_update(&session)["session"].clone();
        let references = fields["speaker_references"].as_object().unwrap();
        assert_eq!(references.len(), 8);
        assert!(references.contains_key("call-1"));
        assert!(!references.contains_key("call-9"));
    }

    #[test]
    fn error_events_keep_mistrals_message() {
        let error = event_error(&json!({
            "type": "error",
            "error": {"message": "Diarization is not compatible with turn detection.", "code": 400}
        }));
        assert_eq!(error.kind, ErrorKind::Provider);
        assert_eq!(
            error.message,
            "API error 400: Diarization is not compatible with turn detection."
        );

        let error =
            event_error(&json!({"type": "error", "error": {"message": "Bad key", "code": "401"}}));
        assert_eq!(error.kind, ErrorKind::Auth);

        let error = event_error(&json!({"type": "error", "error": {"message": {"detail": "x"}}}));
        assert_eq!(error.kind, ErrorKind::Provider);
        assert_eq!(
            error.message,
            "Mistral's realtime transcription failed: {\"detail\":\"x\"}"
        );

        let error = event_error(&json!({"type": "error"}));
        assert_eq!(
            error.message,
            "Mistral's realtime transcription failed: no reason given"
        );
    }
}
