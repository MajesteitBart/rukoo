//! The event log in `bridge.db`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use std::{fmt, fs, io};

use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use serde_json::{Map, Value};
use tokio::sync::broadcast;
use voice_protocol::{
    events, is_instance, new_instance, validate_incoming, EventBody, Invalid, MeetingId, Side,
    MAX_VOICE_MESSAGE,
};

/// The event log's file name in Voice's data folder.
pub const DB_FILE: &str = "bridge.db";

/// How many live events a subscriber may fall behind before it gets `Lagged`.
const LIVE_CAPACITY: usize = 1024;

const SCHEMA_VERSION: i64 = 1;

const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        instance TEXT NOT NULL,
        head INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY,
        event TEXT NOT NULL,
        meeting TEXT,
        created_at INTEGER NOT NULL,
        data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_by_meeting ON events (meeting);
";

/// Room for the envelope around `data` in an `event` message.
const ENVELOPE_BYTES: usize = 256;

/// An event as the log stores it.
#[derive(Clone, Debug, PartialEq)]
pub struct Stored {
    pub seq: u64,
    pub event: String,
    pub meeting: Option<String>,
    pub created_at: u64,
    pub data: Value,
}

impl Stored {
    /// The `event` message that carries this event.
    pub fn to_message(&self) -> Value {
        let mut message = Map::new();
        message.insert("type".into(), "event".into());
        message.insert("seq".into(), self.seq.into());
        message.insert("event".into(), self.event.as_str().into());
        if let Some(meeting) = &self.meeting {
            message.insert("meeting".into(), meeting.as_str().into());
        }
        message.insert("createdAt".into(), self.created_at.into());
        message.insert("data".into(), self.data.clone());
        Value::Object(message)
    }

    pub fn to_json(&self) -> String {
        self.to_message().to_string()
    }
}

/// Why the log couldn't do something.
#[derive(Debug)]
pub enum LogError {
    Db(rusqlite::Error),
    Io(io::Error),
    /// The event breaks a rule of "Checking messages"; Rukoo would drop it.
    Invalid(Invalid),
    /// The event's message would be larger than the 8 MiB Voice may send.
    TooLarge {
        bytes: usize,
    },
    /// `bridge.db` holds something this version can't read.
    Corrupt(String),
}

impl fmt::Display for LogError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LogError::Db(e) => write!(f, "the event log failed: {e}"),
            LogError::Io(e) => write!(f, "the event log's folder failed: {e}"),
            LogError::Invalid(e) => write!(f, "the event is invalid: {e}"),
            LogError::TooLarge { bytes } => {
                write!(
                    f,
                    "the event is {bytes} bytes, more than a message may hold"
                )
            }
            LogError::Corrupt(what) => write!(f, "bridge.db can't be read: {what}"),
        }
    }
}

impl std::error::Error for LogError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            LogError::Db(e) => Some(e),
            LogError::Io(e) => Some(e),
            LogError::Invalid(e) => Some(e),
            LogError::TooLarge { .. } | LogError::Corrupt(_) => None,
        }
    }
}

impl From<rusqlite::Error> for LogError {
    fn from(e: rusqlite::Error) -> LogError {
        LogError::Db(e)
    }
}

impl From<io::Error> for LogError {
    fn from(e: io::Error) -> LogError {
        LogError::Io(e)
    }
}

impl From<Invalid> for LogError {
    fn from(e: Invalid) -> LogError {
        LogError::Invalid(e)
    }
}

/// The events Voice keeps for Rukoo, numbered across restarts.
///
/// Clones share one connection, and so does every [`EventLog::open`] of the same folder in one
/// process. Every method blocks on SQLite; in async code call them from a blocking task.
#[derive(Clone)]
pub struct EventLog {
    inner: Arc<Inner>,
}

/// The logs open in this process, by canonical data folder.
fn open_logs() -> &'static Mutex<HashMap<PathBuf, Weak<Inner>>> {
    static OPEN: OnceLock<Mutex<HashMap<PathBuf, Weak<Inner>>>> = OnceLock::new();
    OPEN.get_or_init(Default::default)
}

struct Inner {
    db: Mutex<Db>,
    instance: String,
    path: PathBuf,
    live: broadcast::Sender<Stored>,
}

struct Db {
    conn: Connection,
    /// The last number given out, which may be above every stored event.
    head: u64,
}

impl EventLog {
    /// Opens `bridge.db` in `data_dir`, creating the folder and the file when they're missing.
    ///
    /// A new file gets a new instance id, which tells Rukoo that the numbers started again.
    /// When this process has the folder's log open already, this returns that log.
    pub fn open(data_dir: &Path) -> Result<EventLog, LogError> {
        EventLog::open_with_live_capacity(data_dir, LIVE_CAPACITY)
    }

    /// [`EventLog::open`] with a smaller live buffer, so tests can make subscribers lag. The
    /// capacity counts only when this opens the file.
    #[doc(hidden)]
    pub fn open_with_live_capacity(
        data_dir: &Path,
        live_capacity: usize,
    ) -> Result<EventLog, LogError> {
        fs::create_dir_all(data_dir)?;
        // A second log on the same file would number events on its own and push them to its
        // own subscribers, so the bridge would never see what the other log appends.
        let key = fs::canonicalize(data_dir).unwrap_or_else(|_| data_dir.to_owned());
        let mut open = open_logs().lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(inner) = open.get(&key).and_then(Weak::upgrade) {
            return Ok(EventLog { inner });
        }
        let inner = Arc::new(Inner::open(data_dir, live_capacity)?);
        open.retain(|_, log| log.strong_count() > 0);
        open.insert(key, Arc::downgrade(&inner));
        Ok(EventLog { inner })
    }
}

impl Inner {
    fn open(data_dir: &Path, live_capacity: usize) -> Result<Inner, LogError> {
        let path = data_dir.join(DB_FILE);
        let mut conn = Connection::open(&path)?;
        conn.query_row("PRAGMA journal_mode=WAL", [], |row| row.get::<_, String>(0))?;
        // NORMAL survives a crash of Voice; a power cut can lose the last events, and Rukoo
        // copes with that the way it copes with removed events.
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.busy_timeout(Duration::from_secs(5))?;

        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let version: i64 = tx.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version > SCHEMA_VERSION {
            return Err(LogError::Corrupt(format!(
                "it has schema version {version}, from a newer Voice"
            )));
        }
        tx.execute_batch(SCHEMA)?;
        tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        let meta: Option<(String, i64)> = tx
            .query_row("SELECT instance, head FROM meta WHERE id = 1", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .optional()?;
        let (instance, head) = match meta {
            Some((instance, head)) => {
                if !is_instance(&instance) {
                    return Err(LogError::Corrupt("its instance id is malformed".into()));
                }
                (instance, from_sql(head)?)
            }
            None => {
                let instance = new_instance()?;
                tx.execute(
                    "INSERT INTO meta (id, instance, head) VALUES (1, ?1, 0)",
                    [&instance],
                )?;
                (instance, 0)
            }
        };
        let highest: Option<i64> =
            tx.query_row("SELECT MAX(seq) FROM events", [], |row| row.get(0))?;
        let head = head.max(highest.map(from_sql).transpose()?.unwrap_or(0));
        tx.commit()?;

        let (live, _) = broadcast::channel(live_capacity.max(1));
        Ok(Inner {
            db: Mutex::new(Db { conn, head }),
            instance,
            path,
            live,
        })
    }
}

impl EventLog {
    /// This data folder's instance id.
    pub fn instance(&self) -> &str {
        &self.inner.instance
    }

    /// The path of `bridge.db`.
    pub fn path(&self) -> &Path {
        &self.inner.path
    }

    /// Stores an event and pushes it to subscribers. Returns its sequence number.
    ///
    /// The event is checked as Rukoo will check it, so a bug that builds a bad event fails here
    /// instead of being stored for good and dropped by Rukoo.
    pub fn append(&self, event: &str, meeting: Option<&str>, data: Value) -> Result<u64, LogError> {
        let created_at = now_ms();
        let (data, data_json) = check(event, meeting, created_at, data)?;
        let mut db = self.lock();
        let head = db.head;
        let tx = db
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let seq = next_seq(&tx, head)?;
        insert(&tx, seq, event, meeting, created_at, &data_json)?;
        tx.commit()?;
        db.head = seq;
        self.push(Stored {
            seq,
            event: event.to_owned(),
            meeting: meeting.map(str::to_owned),
            created_at,
            data,
        });
        Ok(seq)
    }

    /// [`EventLog::append`] for a typed event.
    pub fn append_event(
        &self,
        meeting: Option<&MeetingId>,
        body: EventBody,
    ) -> Result<u64, LogError> {
        let (event, data) = body.into_parts();
        self.append(&event, meeting.map(MeetingId::as_str), data)
    }

    /// Deletes a meeting's events, then appends `meeting.removed` for it. Returns the sequence
    /// number of `meeting.removed`.
    ///
    /// The numbers of the deleted events are never given out again.
    pub fn remove_meeting(&self, meeting: &str) -> Result<u64, LogError> {
        let created_at = now_ms();
        let event = events::MEETING_REMOVED;
        let (data, data_json) = check(event, Some(meeting), created_at, Value::Object(Map::new()))?;
        let mut db = self.lock();
        let head = db.head;
        let tx = db
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let seq = next_seq(&tx, head)?;
        tx.execute("DELETE FROM events WHERE meeting = ?1", [meeting])?;
        insert(&tx, seq, event, Some(meeting), created_at, &data_json)?;
        tx.commit()?;
        db.head = seq;
        self.push(Stored {
            seq,
            event: event.to_owned(),
            meeting: Some(meeting.to_owned()),
            created_at,
            data,
        });
        Ok(seq)
    }

    /// Every stored event after `seq`, oldest first.
    pub fn after(&self, seq: u64) -> Result<Vec<Stored>, LogError> {
        self.page(seq, usize::MAX)
    }

    /// At most `limit` stored events after `seq`, oldest first.
    pub fn page(&self, seq: u64, limit: usize) -> Result<Vec<Stored>, LogError> {
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        let db = self.lock();
        let mut statement = db.conn.prepare_cached(
            "SELECT seq, event, meeting, created_at, data FROM events
             WHERE seq > ?1 ORDER BY seq LIMIT ?2",
        )?;
        let rows = statement.query_map(params![to_sql(seq)?, limit], read_row)?;
        let mut stored = Vec::new();
        for row in rows {
            stored.push(row??);
        }
        Ok(stored)
    }

    /// Every stored event of `meeting`, oldest first, and the head they are complete up to.
    ///
    /// Both are read under one lock, so the events are exactly the meeting's events up to that
    /// head: what `meeting.get` needs for its snapshot.
    pub fn meeting_events(&self, meeting: &str) -> Result<(u64, Vec<Stored>), LogError> {
        let db = self.lock();
        let mut statement = db.conn.prepare_cached(
            "SELECT seq, event, meeting, created_at, data FROM events
             WHERE meeting = ?1 ORDER BY seq",
        )?;
        let rows = statement.query_map([meeting], read_row)?;
        let mut stored = Vec::new();
        for row in rows {
            stored.push(row??);
        }
        Ok((db.head, stored))
    }

    /// The newest stored `event` of `meeting`, such as its last `meeting.state`.
    pub fn latest(&self, meeting: &str, event: &str) -> Result<Option<Stored>, LogError> {
        let db = self.lock();
        let mut statement = db.conn.prepare_cached(
            "SELECT seq, event, meeting, created_at, data FROM events
             WHERE meeting = ?1 AND event = ?2 ORDER BY seq DESC LIMIT 1",
        )?;
        let found = statement
            .query_row(params![meeting, event], read_row)
            .optional()?;
        found.transpose()
    }

    /// The last sequence number given out, or 0.
    pub fn head(&self) -> u64 {
        self.lock().head
    }

    /// The lowest stored sequence number, or `head + 1` when nothing is stored.
    pub fn oldest(&self) -> Result<u64, LogError> {
        Ok(self.bounds()?.1)
    }

    /// `(head, oldest)`, read together.
    pub fn bounds(&self) -> Result<(u64, u64), LogError> {
        let db = self.lock();
        let lowest: Option<i64> = db
            .conn
            .query_row("SELECT MIN(seq) FROM events", [], |row| row.get(0))?;
        let oldest = match lowest {
            Some(lowest) => from_sql(lowest)?,
            None => db.head + 1,
        };
        Ok((db.head, oldest))
    }

    /// Every event appended from now on, in order.
    ///
    /// A subscriber that falls more than 1024 events behind gets `RecvError::Lagged`; it then
    /// reads what it missed with [`EventLog::after`].
    pub fn subscribe(&self) -> broadcast::Receiver<Stored> {
        self.inner.live.subscribe()
    }

    fn push(&self, stored: Stored) {
        // Called with the database locked, so subscribers get events in sequence order. No
        // subscriber is not an error.
        let _ = self.inner.live.send(stored);
    }

    fn lock(&self) -> MutexGuard<'_, Db> {
        // A panic while locked can't leave a half-written event: SQLite rolls the
        // transaction back, and `head` changes only after a commit.
        self.inner.db.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl fmt::Debug for EventLog {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EventLog")
            .field("path", &self.inner.path)
            .field("instance", &self.inner.instance)
            .finish_non_exhaustive()
    }
}

/// Checks an event as Rukoo will and returns its data with the data's JSON.
fn check(
    event: &str,
    meeting: Option<&str>,
    created_at: u64,
    data: Value,
) -> Result<(Value, String), LogError> {
    let mut message = Map::new();
    message.insert("type".into(), "event".into());
    // Any valid number: the real one is given out under the lock.
    message.insert("seq".into(), 1.into());
    message.insert("event".into(), event.into());
    if let Some(meeting) = meeting {
        message.insert("meeting".into(), meeting.into());
    }
    message.insert("createdAt".into(), created_at.into());
    message.insert("data".into(), data);
    let mut message = Value::Object(message);
    validate_incoming(Side::Voice, &message)?;
    let data = message["data"].take();
    let data_json = data.to_string();
    let bytes = data_json.len() + event.len() + ENVELOPE_BYTES;
    if bytes > MAX_VOICE_MESSAGE {
        return Err(LogError::TooLarge { bytes });
    }
    Ok((data, data_json))
}

/// The number for the next event. The head in `meta` counts too: another process with the same
/// data folder (a second development copy) may have given out numbers since this one last did.
fn next_seq(tx: &rusqlite::Transaction<'_>, head: u64) -> Result<u64, LogError> {
    let stored: i64 = tx.query_row("SELECT head FROM meta WHERE id = 1", [], |row| row.get(0))?;
    Ok(head.max(from_sql(stored)?) + 1)
}

fn insert(
    tx: &rusqlite::Transaction<'_>,
    seq: u64,
    event: &str,
    meeting: Option<&str>,
    created_at: u64,
    data_json: &str,
) -> Result<(), LogError> {
    tx.execute(
        "INSERT INTO events (seq, event, meeting, created_at, data) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![to_sql(seq)?, event, meeting, to_sql(created_at)?, data_json],
    )?;
    tx.execute("UPDATE meta SET head = ?1 WHERE id = 1", [to_sql(seq)?])?;
    Ok(())
}

fn read_row(row: &Row<'_>) -> rusqlite::Result<Result<Stored, LogError>> {
    let seq: i64 = row.get(0)?;
    let event: String = row.get(1)?;
    let meeting: Option<String> = row.get(2)?;
    let created_at: i64 = row.get(3)?;
    let data: String = row.get(4)?;
    Ok(stored(seq, event, meeting, created_at, &data))
}

fn stored(
    seq: i64,
    event: String,
    meeting: Option<String>,
    created_at: i64,
    data: &str,
) -> Result<Stored, LogError> {
    let data = serde_json::from_str(data)
        .map_err(|e| LogError::Corrupt(format!("event {seq} holds bad JSON: {e}")))?;
    Ok(Stored {
        seq: from_sql(seq)?,
        event,
        meeting,
        created_at: from_sql(created_at)?,
        data,
    })
}

fn to_sql(value: u64) -> Result<i64, LogError> {
    i64::try_from(value).map_err(|_| LogError::Corrupt(format!("{value} doesn't fit SQLite")))
}

fn from_sql(value: i64) -> Result<u64, LogError> {
    u64::try_from(value).map_err(|_| LogError::Corrupt(format!("a negative number: {value}")))
}

fn now_ms() -> u64 {
    let since_epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    u64::try_from(since_epoch.as_millis()).unwrap_or(u64::MAX)
}
