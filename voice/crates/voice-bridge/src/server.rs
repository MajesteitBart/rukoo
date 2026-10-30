//! The WebSocket server of PROTOCOL.md on `127.0.0.1`.

use std::io;
use std::net::{Ipv4Addr, TcpListener as StdTcpListener};
use std::path::{Path, PathBuf};
use std::sync::{mpsc as std_mpsc, Arc};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use subtle::ConstantTimeEq;
use tokio::net::{TcpListener, TcpStream};
use tokio::runtime::Runtime;
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::{mpsc, watch, OwnedSemaphorePermit, Semaphore};
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::{interval_at, sleep_until, timeout, timeout_at, Instant, MissedTickBehavior};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, WebSocketConfig};
use tokio_tungstenite::tungstenite::{Error as WsError, Message as Frame};
use tokio_tungstenite::WebSocketStream;
use voice_protocol::{
    close, new_token, replay_plan, validate_incoming, Command, CommandBody, ErrorCode, Hello,
    MeetingId, Message, Object, Refusal, Reply, ReplyError, Side, Welcome, BRIDGE_PATH,
    HELLO_TIMEOUT, MAX_CLIENTS, MAX_ID_CHARS, MAX_RUKOO_MESSAGE, MAX_VOICE_MESSAGE, MIN_PROTOCOL,
    PING_INTERVAL, PONG_TIMEOUT, PROTOCOL,
};

use crate::{ControlError, Discovery, EventLog, LogError, MeetingControl, Stored};

type Socket = WebSocketStream<TcpStream>;
type Sink = SplitSink<Socket, Frame>;
type Source = SplitStream<Socket>;

/// Events per read while replaying or catching up.
const PAGE: usize = 500;
/// Connections still in their upgrade or `hello`. More are dropped at once, so a local program
/// that opens sockets and never speaks can't pile up tasks.
const MAX_PENDING: usize = 16;
/// Commands a connection may queue while an earlier one runs.
const COMMAND_QUEUE: usize = 32;
/// How long a close waits for the client's close in return.
const CLOSE_GRACE: Duration = Duration::from_secs(1);
/// How long shutdown waits for connections to close before it drops them.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);
/// WebSocket close code for a message over the size limit.
const CLOSE_TOO_BIG: u16 = 1009;
/// WebSocket close code when the event log fails under a connection.
const CLOSE_INTERNAL: u16 = 1011;

/// The server's timing. The defaults are PROTOCOL.md's; tests shorten them.
#[derive(Clone, Debug)]
pub struct Options {
    /// Time from connecting to a `hello`.
    pub hello_timeout: Duration,
    pub ping_interval: Duration,
    /// Time a ping waits for its pong before the connection closes.
    pub pong_timeout: Duration,
}

impl Default for Options {
    fn default() -> Options {
        Options {
            hello_timeout: HELLO_TIMEOUT,
            ping_interval: PING_INTERVAL,
            pong_timeout: PONG_TIMEOUT,
        }
    }
}

/// Starts the bridge server.
pub struct BridgeServer;

impl BridgeServer {
    /// Listens on `127.0.0.1:0`, then writes the discovery file to `discovery_path`.
    ///
    /// The server runs on its own threads, so this can be called from anywhere, also from an
    /// async task. `version` is Voice's version, for `welcome` and the discovery file.
    pub fn start(
        log: EventLog,
        control: Arc<dyn MeetingControl>,
        discovery_path: &Path,
        version: &str,
    ) -> io::Result<Handle> {
        BridgeServer::start_with(log, control, discovery_path, version, Options::default())
    }

    /// [`BridgeServer::start`] with other timing.
    pub fn start_with(
        log: EventLog,
        control: Arc<dyn MeetingControl>,
        discovery_path: &Path,
        version: &str,
        options: Options,
    ) -> io::Result<Handle> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("voice-bridge")
            .enable_all()
            .build()?;
        match serve(&runtime, log, control, discovery_path, version, options) {
            Ok((port, discovery, shutdown, server)) => Ok(Handle {
                port,
                discovery_path: discovery_path.to_owned(),
                discovery: Some(discovery),
                shutdown,
                server: Some(server),
                runtime: Some(runtime),
            }),
            Err(e) => {
                // Dropping a runtime blocks, which panics inside an async task.
                runtime.shutdown_background();
                Err(e)
            }
        }
    }
}

type Started = (u16, Discovery, watch::Sender<bool>, JoinHandle<()>);

fn serve(
    runtime: &Runtime,
    log: EventLog,
    control: Arc<dyn MeetingControl>,
    discovery_path: &Path,
    version: &str,
    options: Options,
) -> io::Result<Started> {
    let listener = StdTcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    let listener = {
        let _context = runtime.enter();
        TcpListener::from_std(listener)?
    };
    let token = new_token()?;
    let file = voice_protocol::Discovery {
        protocol: PROTOCOL,
        min_protocol: MIN_PROTOCOL,
        port,
        token: token.clone(),
        pid: std::process::id(),
        instance: log.instance().to_owned(),
        voice_version: version.to_owned(),
        started_at: now_ms(),
    };
    let shared = Arc::new(Shared {
        log,
        control,
        token,
        version: version.to_owned(),
        options,
        clients: Arc::new(Semaphore::new(MAX_CLIENTS)),
        pending: Arc::new(Semaphore::new(MAX_PENDING)),
    });
    let (shutdown, quit) = watch::channel(false);
    let server = runtime.spawn(accept(listener, shared, quit));
    // The file comes last: Rukoo may connect the moment it appears.
    match Discovery::write(discovery_path, &file) {
        Ok(discovery) => Ok((port, discovery, shutdown, server)),
        Err(e) => {
            let _ = shutdown.send(true);
            Err(e)
        }
    }
}

/// A running bridge server. Dropping it shuts the server down, as [`Handle::shutdown`] does.
pub struct Handle {
    port: u16,
    discovery_path: PathBuf,
    discovery: Option<Discovery>,
    shutdown: watch::Sender<bool>,
    server: Option<JoinHandle<()>>,
    runtime: Option<Runtime>,
}

impl Handle {
    /// The port on `127.0.0.1`.
    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn discovery_path(&self) -> &Path {
        &self.discovery_path
    }

    /// Removes the discovery file, closes every connection with 1001 and stops the server.
    /// Waits about two seconds at most.
    pub fn shutdown(mut self) {
        self.stop();
    }

    fn stop(&mut self) {
        let Some(runtime) = self.runtime.take() else {
            return;
        };
        // The file goes first, so Rukoo doesn't reconnect to a server that is going away.
        drop(self.discovery.take());
        let _ = self.shutdown.send(true);
        if let Some(server) = self.server.take() {
            let (done, finished) = std_mpsc::channel();
            runtime.spawn(async move {
                let _ = server.await;
                let _ = done.send(());
            });
            let _ = finished.recv_timeout(SHUTDOWN_GRACE + CLOSE_GRACE);
        }
        runtime.shutdown_background();
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        self.stop();
    }
}

struct Shared {
    log: EventLog,
    control: Arc<dyn MeetingControl>,
    token: String,
    version: String,
    options: Options,
    clients: Arc<Semaphore>,
    pending: Arc<Semaphore>,
}

async fn accept(listener: TcpListener, shared: Arc<Shared>, mut quit: watch::Receiver<bool>) {
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            _ = quit.changed() => break,
            accepted = listener.accept() => match accepted {
                Ok((tcp, _)) => {
                    let Ok(pending) = shared.pending.clone().try_acquire_owned() else {
                        continue;
                    };
                    connections.spawn(connection(tcp, shared.clone(), pending, quit.clone()));
                }
                // Out of sockets or handles; give the system a moment instead of spinning.
                Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
            },
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
        }
    }
    drop(listener);
    let closing = async { while connections.join_next().await.is_some() {} };
    let _ = timeout(SHUTDOWN_GRACE, closing).await;
    connections.abort_all();
}

async fn connection(
    tcp: TcpStream,
    shared: Arc<Shared>,
    pending: OwnedSemaphorePermit,
    quit: watch::Receiver<bool>,
) {
    let _ = tcp.set_nodelay(true);
    // The time for `hello` runs from the connection, so a slow upgrade counts too.
    let deadline = Instant::now() + shared.options.hello_timeout;
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_RUKOO_MESSAGE))
        .max_frame_size(Some(MAX_RUKOO_MESSAGE));
    let upgrade = tokio_tungstenite::accept_hdr_async_with_config(tcp, check_upgrade, Some(config));
    let Ok(Ok(socket)) = timeout_at(deadline, upgrade).await else {
        return;
    };
    let (sink, mut source) = socket.split();
    let admitted = match timeout_at(deadline, first_message(&mut source)).await {
        Err(_) => Err(Refusal::HelloTimeout),
        Ok(First::Closed) => return,
        Ok(First::Refused(refusal)) => Err(refusal),
        Ok(First::Hello(hello)) => admit(&shared, hello),
    };
    drop(pending);
    match admitted {
        Err(refusal) => refuse(sink, source, refusal).await,
        Ok((hello, _slot)) => Session::new(shared, sink, quit).run(hello, source).await,
    }
}

/// Refuses a browser's upgrade request and anything not on `/bridge`.
// tungstenite's `Callback` fixes this signature, large error and all.
#[allow(clippy::result_large_err)]
fn check_upgrade(request: &Request, response: Response) -> Result<Response, ErrorResponse> {
    if request.uri().path() != BRIDGE_PATH {
        return Err(refuse_upgrade(StatusCode::NOT_FOUND));
    }
    // Any web page can try to open a socket on 127.0.0.1, and a browser always says which page
    // it is. Rukoo connects from its main process, which sends no Origin.
    let from_a_page = request
        .headers()
        .get_all("origin")
        .iter()
        .any(|origin| is_web_origin(origin.as_bytes()));
    if from_a_page {
        return Err(refuse_upgrade(StatusCode::FORBIDDEN));
    }
    Ok(response)
}

fn is_web_origin(origin: &[u8]) -> bool {
    let origin = origin.trim_ascii();
    let starts_with = |prefix: &[u8]| {
        origin.len() >= prefix.len() && origin[..prefix.len()].eq_ignore_ascii_case(prefix)
    };
    starts_with(b"http://") || starts_with(b"https://")
}

fn refuse_upgrade(status: StatusCode) -> ErrorResponse {
    let mut response = ErrorResponse::new(None);
    *response.status_mut() = status;
    response
}

enum First {
    Hello(Hello),
    Refused(Refusal),
    Closed,
}

async fn first_message(source: &mut Source) -> First {
    while let Some(frame) = source.next().await {
        let text = match frame {
            Ok(Frame::Text(text)) => text,
            Ok(Frame::Ping(_) | Frame::Pong(_) | Frame::Frame(_)) => continue,
            Ok(Frame::Binary(_)) => return First::Refused(Refusal::HelloTimeout),
            Ok(Frame::Close(_)) | Err(_) => return First::Closed,
        };
        let Ok(value) = serde_json::from_str::<Value>(&text) else {
            return First::Refused(Refusal::HelloTimeout);
        };
        return match validate_incoming(Side::Rukoo, &value) {
            Ok(Message::Hello(hello)) => First::Hello(hello),
            // A hello with a malformed token or version gets the answer a wrong one gets.
            Err(invalid) if value["type"] == "hello" => {
                First::Refused(match invalid.reason.as_str() {
                    "token" => Refusal::BadToken,
                    "protocol" => Refusal::UnsupportedProtocol,
                    _ => Refusal::HelloTimeout,
                })
            }
            Ok(_) | Err(_) => First::Refused(Refusal::HelloTimeout),
        };
    }
    First::Closed
}

fn admit(shared: &Shared, hello: Hello) -> Result<(Hello, OwnedSemaphorePermit), Refusal> {
    let token_matches: bool = hello.token.as_bytes().ct_eq(shared.token.as_bytes()).into();
    if !token_matches {
        return Err(Refusal::BadToken);
    }
    if !(MIN_PROTOCOL..=PROTOCOL).contains(&hello.protocol) {
        return Err(Refusal::UnsupportedProtocol);
    }
    // Only a client with the token takes a slot, so a program without it can't keep Rukoo out.
    let slot = shared
        .clients
        .clone()
        .try_acquire_owned()
        .map_err(|_| Refusal::TooManyClients)?;
    Ok((hello, slot))
}

async fn refuse(mut sink: Sink, source: Source, refusal: Refusal) {
    let error = Message::Error(refusal.message()).to_json();
    if sink.send(Frame::text(error)).await.is_ok() {
        close(sink, source, refusal.close_code(), "").await;
    }
}

/// Sends a close frame and waits briefly for the client's, so the client reads ours before the
/// TCP connection ends.
async fn close(mut sink: Sink, mut source: Source, code: u16, reason: &'static str) {
    let frame = CloseFrame {
        code: CloseCode::from(code),
        reason: reason.into(),
    };
    if sink.send(Frame::Close(Some(frame))).await.is_err() {
        return;
    }
    let drain = async { while let Some(Ok(_)) = source.next().await {} };
    let _ = timeout(CLOSE_GRACE, drain).await;
}

/// How a session ended.
enum End {
    Quit,
    TooBig,
    LogFailed,
    ClientClosed,
    Dropped,
}

/// A connection after a good `hello`.
struct Session {
    shared: Arc<Shared>,
    sink: Sink,
    quit: watch::Receiver<bool>,
    /// The highest sequence number sent on this connection.
    last: u64,
}

impl Session {
    fn new(shared: Arc<Shared>, sink: Sink, quit: watch::Receiver<bool>) -> Session {
        Session {
            shared,
            sink,
            quit,
            last: 0,
        }
    }

    async fn run(mut self, hello: Hello, mut source: Source) {
        let end = match self.serve(hello, &mut source).await {
            Ok(end) => end,
            Err(end) => end,
        };
        let Session { sink, .. } = self;
        match end {
            End::Quit => close(sink, source, close::QUITTING, "Voice is quitting").await,
            End::TooBig => close(sink, source, CLOSE_TOO_BIG, "").await,
            End::LogFailed => close(sink, source, CLOSE_INTERNAL, "").await,
            End::ClientClosed => {
                // tungstenite answered the client's close already; send it on its way.
                let mut sink = sink;
                let _ = sink.close().await;
            }
            End::Dropped => {}
        }
    }

    async fn serve(&mut self, hello: Hello, source: &mut Source) -> Result<End, End> {
        // Subscribe before reading the log: an event appended meanwhile then arrives both ways,
        // and `last` drops the second copy, instead of falling between the two.
        let mut live = self.shared.log.subscribe();
        let log = self.shared.log.clone();
        let (head, oldest) = blocking(move || log.bounds()).await?;
        let instance = self.shared.log.instance();
        let (replay, from) = replay_plan(
            hello.instance.as_deref(),
            hello.after,
            instance,
            head,
            oldest,
        );
        let control = self.shared.control.clone();
        let status = tokio::task::spawn_blocking(move || control.status())
            .await
            .unwrap_or_default();
        let welcome = Welcome {
            protocol: hello.protocol,
            voice_version: self.shared.version.clone(),
            instance: instance.to_owned(),
            head,
            oldest,
            replay,
            status,
        };
        self.send(Message::Welcome(welcome).to_json()).await?;
        self.last = from.saturating_sub(1);
        self.catch_up().await?;

        let (jobs, queue) = mpsc::channel(COMMAND_QUEUE);
        // Unbounded, so the worker never waits on this loop while this loop waits on the worker.
        let (replies_out, mut replies) = mpsc::unbounded_channel();
        let worker = tokio::spawn(run_commands(
            self.shared.control.clone(),
            queue,
            replies_out,
        ));
        let end = self.live(&mut live, source, &jobs, &mut replies).await;
        worker.abort();
        end
    }

    async fn live(
        &mut self,
        live: &mut tokio::sync::broadcast::Receiver<Stored>,
        source: &mut Source,
        jobs: &mpsc::Sender<Job>,
        replies: &mut mpsc::UnboundedReceiver<String>,
    ) -> Result<End, End> {
        let options = &self.shared.options;
        let mut ping = interval_at(
            Instant::now() + options.ping_interval,
            options.ping_interval,
        );
        ping.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let pong_timeout = options.pong_timeout;
        let mut pong_due: Option<Instant> = None;
        if *self.quit.borrow() {
            return Ok(End::Quit);
        }
        loop {
            tokio::select! {
                _ = self.quit.changed() => return Ok(End::Quit),
                frame = source.next() => match frame {
                    Some(Ok(Frame::Text(text))) => {
                        if let Some(job) = read_command(&text) {
                            jobs.send(job).await.map_err(|_| End::Dropped)?;
                        }
                    }
                    Some(Ok(Frame::Pong(_))) => pong_due = None,
                    // tungstenite answers pings; binary frames mean nothing here.
                    Some(Ok(Frame::Ping(_) | Frame::Binary(_) | Frame::Frame(_))) => {}
                    Some(Ok(Frame::Close(_))) | None => return Ok(End::ClientClosed),
                    Some(Err(WsError::Capacity(_))) => return Ok(End::TooBig),
                    Some(Err(_)) => return Ok(End::Dropped),
                },
                received = live.recv() => match received {
                    Ok(stored) if stored.seq <= self.last => {}
                    Ok(stored) if stored.seq == self.last + 1 => {
                        self.last = stored.seq;
                        self.send(stored.to_json()).await?;
                    }
                    // A burst outran the channel, or an event went missing in it: the log has
                    // every event that still exists.
                    Ok(_) | Err(RecvError::Lagged(_)) => self.catch_up().await?,
                    Err(RecvError::Closed) => return Ok(End::Dropped),
                },
                Some(reply) = replies.recv() => self.send(reply).await?,
                _ = ping.tick() => {
                    if pong_due.is_none() {
                        self.sink
                            .send(Frame::Ping(Default::default()))
                            .await
                            .map_err(|_| End::Dropped)?;
                        pong_due = Some(Instant::now() + pong_timeout);
                    }
                }
                _ = sleep_until(pong_due.unwrap_or_else(Instant::now)), if pong_due.is_some() => {
                    // No answer: the peer is gone or stuck. A close frame would wait for it too.
                    return Ok(End::Dropped);
                }
            }
        }
    }

    /// Sends every stored event after `last`, page by page.
    async fn catch_up(&mut self) -> Result<(), End> {
        loop {
            let log = self.shared.log.clone();
            let after = self.last;
            let page = blocking(move || log.page(after, PAGE)).await?;
            let more = page.len() == PAGE;
            for stored in page {
                self.sink
                    .feed(Frame::text(stored.to_json()))
                    .await
                    .map_err(|_| End::Dropped)?;
                self.last = stored.seq;
            }
            self.sink.flush().await.map_err(|_| End::Dropped)?;
            if !more {
                return Ok(());
            }
        }
    }

    async fn send(&mut self, json: String) -> Result<(), End> {
        self.sink
            .send(Frame::text(json))
            .await
            .map_err(|_| End::Dropped)
    }
}

/// Runs an event log call on a blocking thread.
async fn blocking<T, F>(call: F) -> Result<T, End>
where
    F: FnOnce() -> Result<T, LogError> + Send + 'static,
    T: Send + 'static,
{
    match tokio::task::spawn_blocking(call).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(_)) | Err(_) => Err(End::LogFailed),
    }
}

/// One entry in a connection's command queue. Answers to bad commands queue too, so every
/// reply leaves in the order its command came in.
enum Job {
    Run(Command),
    Answer(Reply),
}

/// The job for a text frame, or `None` when there is nothing to answer.
fn read_command(text: &str) -> Option<Job> {
    let value: Value = serde_json::from_str(text).ok()?;
    match validate_incoming(Side::Rukoo, &value) {
        Ok(Message::Command(command)) => Some(Job::Run(command)),
        // A second hello.
        Ok(_) => None,
        Err(invalid) => {
            if value["type"] != "command" {
                return None;
            }
            // A bad command is answered when its id can be read.
            let id = value["id"]
                .as_str()
                .filter(|id| !id.is_empty() && id.chars().count() <= MAX_ID_CHARS)?;
            let message = format!("The command's `{}` is missing or invalid.", invalid.reason);
            Some(Job::Answer(Reply::error(
                id,
                ReplyError::new(ErrorCode::BadRequest, message),
            )))
        }
    }
}

async fn run_commands(
    control: Arc<dyn MeetingControl>,
    mut queue: mpsc::Receiver<Job>,
    replies: mpsc::UnboundedSender<String>,
) {
    while let Some(job) = queue.recv().await {
        let reply = match job {
            Job::Answer(reply) => reply,
            Job::Run(Command { id, body }) => {
                let control = control.clone();
                match tokio::task::spawn_blocking(move || dispatch(control.as_ref(), body)).await {
                    Ok(Ok(result)) => Reply::ok(id, result),
                    Ok(Err(error)) => Reply::error(id, reply_error(error)),
                    Err(_) => Reply::error(
                        id,
                        ReplyError::new(
                            ErrorCode::Failed,
                            "Voice failed while running the command.",
                        ),
                    ),
                }
            }
        };
        if replies.send(within_limit(reply)).is_err() {
            return;
        }
    }
}

fn dispatch(control: &dyn MeetingControl, body: CommandBody) -> Result<Object, ControlError> {
    let result = match body {
        CommandBody::MeetingStart(args) => json!({ "meeting": control.start(args)? }),
        CommandBody::MeetingStop { meeting } => {
            control.stop(meeting.as_str())?;
            json!({})
        }
        CommandBody::MeetingPause { meeting } => {
            control.pause(meeting.as_str())?;
            json!({})
        }
        CommandBody::MeetingResume { meeting } => {
            control.resume(meeting.as_str())?;
            json!({})
        }
        CommandBody::MeetingMark { meeting, label } => {
            let (mark, at) = control.mark(meeting.as_str(), label.as_deref())?;
            json!({ "mark": mark, "at": at })
        }
        CommandBody::MeetingList { limit } => {
            let limit = usize::try_from(limit).unwrap_or(usize::MAX);
            json!({ "meetings": control.list(limit) })
        }
        CommandBody::MeetingGet { meeting } => control.get(meeting.as_str())?,
        CommandBody::FrameGet { meeting, at } => control.frame(meeting.as_str(), at)?,
        CommandBody::StatusGet => json!(control.status()),
        CommandBody::Unknown { command, .. } => {
            return Err(ControlError::new(
                ErrorCode::UnknownCommand,
                format!("Voice doesn't know the command `{command}`."),
            ))
        }
    };
    match result {
        Value::Object(result) => Ok(result),
        _ => Err(ControlError::failed(
            "Voice built a result that isn't an object.",
        )),
    }
}

fn reply_error(error: ControlError) -> ReplyError {
    ReplyError {
        code: error.code.as_str().to_owned(),
        message: error.message,
        // A malformed id would make Rukoo drop the whole reply; the code alone still helps.
        meeting: error.meeting.as_deref().and_then(MeetingId::parse),
    }
}

/// The reply as JSON, or a `failed` reply when it is over the 8 MiB Voice may send.
fn within_limit(reply: Reply) -> String {
    let json = Message::Reply(reply.clone()).to_json();
    if json.len() <= MAX_VOICE_MESSAGE {
        return json;
    }
    let message = format!(
        "The reply would be {} bytes, more than a message may hold.",
        json.len()
    );
    Message::Reply(Reply::error(
        reply.id,
        ReplyError::new(ErrorCode::Failed, message),
    ))
    .to_json()
}

fn now_ms() -> u64 {
    let since_epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    u64::try_from(since_epoch.as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn web_origins() {
        assert!(is_web_origin(b"https://evil.example"));
        assert!(is_web_origin(b"HTTP://localhost:3000"));
        assert!(is_web_origin(b"  http://x "));
        assert!(!is_web_origin(b"null"));
        assert!(!is_web_origin(b"file://"));
        assert!(!is_web_origin(b"httpx://a"));
        assert!(!is_web_origin(b""));
    }

    #[test]
    fn bad_commands_with_a_readable_id_get_bad_request() {
        let Some(Job::Answer(reply)) =
            read_command(r#"{"type":"command","id":"c-1","command":"meeting.stop","args":{}}"#)
        else {
            panic!("no answer");
        };
        assert_eq!(reply.id, "c-1");
        assert_eq!(reply.outcome.unwrap_err().code, "bad_request");
        assert!(read_command(r#"{"type":"command","command":"meeting.stop"}"#).is_none());
        assert!(read_command("not json").is_none());
        assert!(read_command(r#"{"type":"greeting"}"#).is_none());
    }

    #[test]
    fn oversized_replies_become_failures() {
        let mut result = Object::new();
        result.insert("blob".into(), "x".repeat(MAX_VOICE_MESSAGE).into());
        let json = within_limit(Reply::ok("c-9", result));
        let value: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["id"], "c-9");
        assert_eq!(value["error"]["code"], "failed");
    }
}
