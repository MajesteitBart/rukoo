//! `transcript.db`: a meeting's transcript and the pipeline's bookkeeping.
//!
//! It holds the passages, speakers and marks, how far each track is transcribed, and which events
//! already went into the event log, so a pipeline that starts again after a crash or a quit
//! continues where the last one stopped and sends nothing twice. Only the app writes it; the
//! recorder never opens it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde_json::Value;
use voice_protocol::{passage_id, Mark, MeetingState, Passage, Speaker, Track};

use crate::segmentation::Token;
use crate::speakers::turns::Turn;

pub const FILE_NAME: &str = "transcript.db";

/// Tables added later keep version 1: they are created with `IF NOT EXISTS`, and an older Voice
/// ignores them, while a higher version would make it refuse the whole file.
const SCHEMA_VERSION: i64 = 1;

/// How the meeting's call speakers are labelled: `off`, `nemotron` or `mistral`. Set once.
pub const MODE_KEY: &str = "speakers.mode";
/// Why the mode is `off`: a Settings reason code, or `upgrade` for a meeting from Voice 0.1.
pub const REASON_KEY: &str = "speakers.reason";
/// Meeting ms up to which the call's speaker turns are final.
pub const SETTLED_KEY: &str = "speakers.settled.call";
/// Meeting ms up to which call passages without a speaker were looked at again.
pub const BACKFILL_KEY: &str = "speakers.backfill.call";
/// `1` when Mistral labels the call's voices, `0` when its stream only transcribes.
pub const DIARIZE_KEY: &str = "speakers.diarize";

/// Meeting ms up to which Mistral answered for a track's stream.
pub fn answered_key(track: Track) -> String {
    format!("stream.answered.{}", track.as_str())
}

/// The last stream segment of a track that a window took, as `epoch:n`.
pub fn taken_key(track: Track) -> String {
    format!("stream.taken.{}", track.as_str())
}

const SCHEMA: &str = r#"
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS progress (track TEXT PRIMARY KEY, cursor INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS windows (
        track TEXT NOT NULL,
        start INTEGER NOT NULL,
        "end" INTEGER NOT NULL,
        reason TEXT NOT NULL,
        PRIMARY KEY (track, start)
    );
    CREATE TABLE IF NOT EXISTS passages (
        id TEXT PRIMARY KEY,
        track TEXT NOT NULL,
        speaker TEXT,
        start INTEGER NOT NULL,
        "end" INTEGER NOT NULL,
        text TEXT NOT NULL,
        revision INTEGER NOT NULL,
        dictation INTEGER NOT NULL,
        language TEXT,
        tokens TEXT
    );
    CREATE INDEX IF NOT EXISTS passages_by_start ON passages (start);
    CREATE TABLE IF NOT EXISTS speakers (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS marks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS emitted (key TEXT PRIMARY KEY, seq INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS speaker_epochs (
        epoch INTEGER PRIMARY KEY,
        track TEXT NOT NULL,
        engine TEXT NOT NULL,
        opened_at INTEGER NOT NULL,
        feed_from INTEGER NOT NULL,
        reason TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS speaker_map (
        epoch INTEGER NOT NULL,
        label TEXT NOT NULL,
        speaker TEXT NOT NULL,
        how TEXT NOT NULL,
        PRIMARY KEY (epoch, label)
    );
    CREATE TABLE IF NOT EXISTS speaker_turns (
        track TEXT NOT NULL,
        speaker TEXT NOT NULL,
        start INTEGER NOT NULL,
        "end" INTEGER,
        epoch INTEGER NOT NULL,
        PRIMARY KEY (track, speaker, start)
    );
    CREATE INDEX IF NOT EXISTS speaker_turns_by_start ON speaker_turns (track, start);
    CREATE TABLE IF NOT EXISTS stream_segments (
        track TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        n INTEGER NOT NULL,
        label TEXT,
        text TEXT NOT NULL,
        start INTEGER NOT NULL,
        "end" INTEGER NOT NULL,
        timed INTEGER NOT NULL,
        PRIMARY KEY (track, epoch, n)
    );
"#;

/// One labelling stream of a meeting: a Nemotron worker stream, or a Mistral session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Epoch {
    /// 1, 2, ... per meeting.
    pub epoch: u64,
    pub track: Track,
    /// `nemotron` or `mistral`.
    pub engine: String,
    /// Wall ms, for logs only.
    pub opened_at: u64,
    /// Meeting ms where the stream's stored output starts.
    pub feed_from: u64,
    /// `start`, `crash`, `restart` or `reconnect`.
    pub reason: String,
}

/// A stream's own label for a voice, and the `call-N` id it got.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MapRow {
    pub epoch: u64,
    pub label: String,
    pub speaker: String,
    /// `new` or `matched`.
    pub how: String,
}

/// A speaker turn as the follower writes it, in meeting ms; `end` is `None` while it is open.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TurnRow {
    pub speaker: String,
    pub start: u64,
    pub end: Option<u64>,
    pub epoch: u64,
}

/// What one step of a follower learned, written in one transaction.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LabelBatch {
    pub map: Vec<MapRow>,
    /// Turns to store; one with an end replaces the open turn of the same speaker and start.
    pub turns: Vec<TurnRow>,
    /// The new settled position in meeting ms; a lower value than the stored one is ignored.
    pub settled: Option<u64>,
}

impl LabelBatch {
    pub fn is_empty(&self) -> bool {
        self.map.is_empty() && self.turns.is_empty() && self.settled.is_none()
    }
}

/// A piece of text Mistral's realtime stream returned, in meeting ms.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredSegment {
    pub track: Track,
    pub epoch: u64,
    /// Order within the epoch.
    pub n: u64,
    /// Mistral's `speaker_id`; `None` for text deltas and the microphone.
    pub label: Option<String>,
    pub text: String,
    pub start: u64,
    pub end: u64,
    /// Whether Mistral sent the times, rather than Voice estimating them.
    pub timed: bool,
}

/// The number of a `call-N` id.
pub fn call_number(id: &str) -> Option<u64> {
    id.strip_prefix("call-")?.parse().ok().filter(|&n| n > 0)
}

/// How the meeting's processing ended, or that it is processing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outcome {
    /// `processing`, `done` or `failed`.
    pub state: MeetingState,
    /// Meeting time of the end of the recording.
    pub at: u64,
    /// Wall time of the end of the recording.
    pub ended_at: u64,
    pub reason: Option<String>,
    /// Wall time the transcript was complete, for `done`.
    pub done_at: Option<u64>,
}

/// A passage with the word timings it was built from, kept so speaker labels can split it later.
#[derive(Clone, Debug, PartialEq)]
pub struct StoredPassage {
    pub passage: Passage,
    pub tokens: Vec<Token>,
}

/// A meeting's `transcript.db`.
pub struct Transcript {
    conn: Connection,
    path: PathBuf,
}

impl std::fmt::Debug for Transcript {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Transcript")
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

impl Transcript {
    /// Opens or creates `transcript.db` in a meeting folder.
    pub fn open(meeting_dir: &Path) -> rusqlite::Result<Transcript> {
        let path = meeting_dir.join(FILE_NAME);
        let mut conn = Connection::open(&path)?;
        conn.query_row("PRAGMA journal_mode=WAL", [], |row| row.get::<_, String>(0))?;
        // A crash of Voice keeps every commit; a power cut may lose the last ones, which the
        // pipeline then does again from the recorded audio.
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.busy_timeout(Duration::from_secs(5))?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let version: i64 = tx.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version > SCHEMA_VERSION {
            return Err(rusqlite::Error::InvalidParameterName(format!(
                "{} has schema version {version}, from a newer Voice",
                path.display()
            )));
        }
        tx.execute_batch(SCHEMA)?;
        tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        tx.commit()?;
        Ok(Transcript { conn, path })
    }

    /// How far `track` is transcribed, in meeting samples.
    pub fn cursor(&self, track: Track) -> rusqlite::Result<u64> {
        let cursor: Option<i64> = self
            .conn
            .query_row(
                "SELECT cursor FROM progress WHERE track = ?1",
                [track.as_str()],
                |row| row.get(0),
            )
            .optional()?;
        Ok(cursor.map_or(0, to_u64))
    }

    /// Stores a window: its passages, and the track's cursor moving from `start` to `end`, in one
    /// transaction. Passage ids that are taken already move their start on by a millisecond.
    ///
    /// Returns the passages as stored, or `None` without changing anything when the cursor isn't
    /// at `start`: another pipeline got there first.
    pub fn commit_window(
        &mut self,
        track: Track,
        start: u64,
        end: u64,
        reason: &str,
        passages: Vec<StoredPassage>,
    ) -> rusqlite::Result<Option<Vec<StoredPassage>>> {
        self.commit_window_with(track, start, end, reason, passages, &[])
    }

    /// [`Transcript::commit_window`] that also sets `meta` keys in the same transaction.
    pub fn commit_window_with(
        &mut self,
        track: Track,
        start: u64,
        end: u64,
        reason: &str,
        passages: Vec<StoredPassage>,
        meta: &[(String, String)],
    ) -> rusqlite::Result<Option<Vec<StoredPassage>>> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let cursor: Option<i64> = tx
            .query_row(
                "SELECT cursor FROM progress WHERE track = ?1",
                [track.as_str()],
                |row| row.get(0),
            )
            .optional()?;
        if cursor.map_or(0, to_u64) != start {
            return Ok(None);
        }
        let mut stored = Vec::with_capacity(passages.len());
        for mut p in passages {
            loop {
                let id = passage_id(track, p.passage.start);
                let taken: bool = tx.query_row(
                    "SELECT EXISTS (SELECT 1 FROM passages WHERE id = ?1)",
                    [&id],
                    |row| row.get(0),
                )?;
                if !taken {
                    p.passage.id = id;
                    break;
                }
                p.passage.start += 1;
                p.passage.end = p.passage.end.max(p.passage.start);
            }
            insert_passage(&tx, &p)?;
            stored.push(p);
        }
        tx.execute(
            r#"INSERT OR REPLACE INTO windows (track, start, "end", reason) VALUES (?1, ?2, ?3, ?4)"#,
            params![track.as_str(), to_i64(start), to_i64(end), reason],
        )?;
        tx.execute(
            "INSERT OR REPLACE INTO progress (track, cursor) VALUES (?1, ?2)",
            params![track.as_str(), to_i64(end)],
        )?;
        for (key, value) in meta {
            tx.execute(
                "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)",
                params![key, value],
            )?;
        }
        tx.commit()?;
        Ok(Some(stored))
    }

    pub fn meta_get(&self, key: &str) -> rusqlite::Result<Option<String>> {
        self.conn
            .query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| {
                row.get(0)
            })
            .optional()
    }

    pub fn meta_set(&self, key: &str, value: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)",
            params![key, value],
        )?;
        Ok(())
    }

    /// A meta value that holds a number; `None` when it is missing or isn't one.
    pub fn meta_u64(&self, key: &str) -> rusqlite::Result<Option<u64>> {
        Ok(self.meta_get(key)?.and_then(|v| v.parse().ok()))
    }

    /// Sets a number unless the stored one is higher already. Returns the value it holds now.
    pub fn meta_raise(&self, key: &str, value: u64) -> rusqlite::Result<u64> {
        raise(&self.conn, key, value)
    }

    /// Whether a passage on `track` is stored.
    pub fn has_passage_on(&self, track: Track) -> rusqlite::Result<bool> {
        self.conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM passages WHERE track = ?1)",
            [track.as_str()],
            |row| row.get(0),
        )
    }

    /// The speaker turns on `track` that overlap `[from_ms, to_ms)`, by start. An open turn ends
    /// at the stored settled position, and never before its start.
    pub fn turns(&self, track: Track, from_ms: u64, to_ms: u64) -> rusqlite::Result<Vec<Turn>> {
        let settled = self
            .meta_u64(&format!("speakers.settled.{}", track.as_str()))?
            .unwrap_or(0);
        let mut statement = self.conn.prepare(
            r#"SELECT speaker, start, "end" FROM speaker_turns
               WHERE track = ?1 AND start < ?3 AND ("end" IS NULL OR "end" > ?2)
               ORDER BY start, speaker"#,
        )?;
        let rows = statement.query_map(
            params![track.as_str(), to_i64(from_ms), to_i64(to_ms)],
            |row| {
                let start = to_u64(row.get(1)?);
                let end: Option<i64> = row.get(2)?;
                Ok(Turn {
                    speaker: row.get(0)?,
                    start,
                    end: end.map_or(settled.max(start), to_u64),
                })
            },
        )?;
        let turns: Vec<Turn> = rows.collect::<rusqlite::Result<_>>()?;
        // An open turn that ends at the settled position may end before `from_ms`.
        Ok(turns
            .into_iter()
            .filter(|t| t.end > from_ms || t.start >= from_ms)
            .collect())
    }

    /// The `call-N` speakers stored so far, by number.
    pub fn speaker_ids(&self) -> rusqlite::Result<Vec<String>> {
        let mut statement = self.conn.prepare("SELECT id FROM speakers")?;
        let mut ids: Vec<(u64, String)> = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .filter_map(|id| match id {
                Ok(id) => call_number(&id).map(|n| Ok((n, id))),
                Err(e) => Some(Err(e)),
            })
            .collect::<rusqlite::Result<_>>()?;
        ids.sort();
        Ok(ids.into_iter().map(|(_, id)| id).collect())
    }

    /// The highest `N` of a `call-N` given so far, in the stream maps or as a stored speaker.
    pub fn highest_speaker_number(&self) -> rusqlite::Result<u64> {
        let mut highest = 0;
        let mut statement = self
            .conn
            .prepare("SELECT speaker FROM speaker_map UNION SELECT id FROM speakers")?;
        for id in statement.query_map([], |row| row.get::<_, String>(0))? {
            highest = highest.max(call_number(&id?).unwrap_or(0));
        }
        Ok(highest)
    }

    /// The `call-N` id each stream label got, by epoch and label.
    pub fn speaker_map(&self) -> rusqlite::Result<HashMap<(u64, String), String>> {
        let mut statement = self
            .conn
            .prepare("SELECT epoch, label, speaker FROM speaker_map")?;
        let rows = statement.query_map([], |row| {
            Ok(((to_u64(row.get(0)?), row.get(1)?), row.get(2)?))
        })?;
        rows.collect()
    }

    /// The number the next labelling stream gets.
    pub fn next_epoch(&self) -> rusqlite::Result<u64> {
        let highest: Option<i64> =
            self.conn
                .query_row("SELECT MAX(epoch) FROM speaker_epochs", [], |row| {
                    row.get(0)
                })?;
        Ok(highest.map_or(0, to_u64) + 1)
    }

    /// Records a new labelling stream and returns its number: the next free one, taken in the
    /// same transaction, so the call's and the microphone's streams never share one.
    /// `feed_from` is in meeting ms.
    pub fn open_epoch(
        &mut self,
        track: Track,
        engine: &str,
        feed_from: u64,
        reason: &str,
    ) -> rusqlite::Result<u64> {
        let opened_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX));
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let highest: Option<i64> =
            tx.query_row("SELECT MAX(epoch) FROM speaker_epochs", [], |row| {
                row.get(0)
            })?;
        let epoch = highest.map_or(0, to_u64) + 1;
        tx.execute(
            "INSERT INTO speaker_epochs (epoch, track, engine, opened_at, feed_from, reason)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                to_i64(epoch),
                track.as_str(),
                engine,
                to_i64(opened_at),
                to_i64(feed_from),
                reason
            ],
        )?;
        tx.commit()?;
        Ok(epoch)
    }

    /// Every labelling stream so far, in order.
    pub fn epochs(&self) -> rusqlite::Result<Vec<Epoch>> {
        let mut statement = self.conn.prepare(
            "SELECT epoch, track, engine, opened_at, feed_from, reason FROM speaker_epochs ORDER BY epoch",
        )?;
        let rows = statement.query_map([], |row| {
            let track: String = row.get(1)?;
            Ok(Epoch {
                epoch: to_u64(row.get(0)?),
                track: Track::parse(&track).unwrap_or(Track::Call),
                engine: row.get(2)?,
                opened_at: to_u64(row.get(3)?),
                feed_from: to_u64(row.get(4)?),
                reason: row.get(5)?,
            })
        })?;
        rows.collect()
    }

    /// Writes what a follower learned: new labels, turns and the settled position, at once.
    pub fn record_labels(&mut self, batch: &LabelBatch) -> rusqlite::Result<()> {
        if batch.is_empty() {
            return Ok(());
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        for row in &batch.map {
            tx.execute(
                "INSERT OR REPLACE INTO speaker_map (epoch, label, speaker, how) VALUES (?1, ?2, ?3, ?4)",
                params![to_i64(row.epoch), row.label, row.speaker, row.how],
            )?;
        }
        for turn in &batch.turns {
            tx.execute(
                r#"INSERT INTO speaker_turns (track, speaker, start, "end", epoch)
                   VALUES ('call', ?1, ?2, ?3, ?4)
                   ON CONFLICT (track, speaker, start) DO UPDATE SET
                       "end" = COALESCE(excluded."end", speaker_turns."end")"#,
                params![
                    turn.speaker,
                    to_i64(turn.start),
                    turn.end.map(to_i64),
                    to_i64(turn.epoch)
                ],
            )?;
        }
        if let Some(settled) = batch.settled {
            raise(&tx, SETTLED_KEY, settled)?;
        }
        tx.commit()
    }

    /// Ends the call's speaker turns at `at_ms`, for a stream that stopped: open turns and turns
    /// past it end there, and turns that start at or after it go, since the next stream hears
    /// that audio again.
    pub fn close_open_turns(&mut self, at_ms: u64) -> rusqlite::Result<()> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "DELETE FROM speaker_turns WHERE track = 'call' AND start >= ?1",
            [to_i64(at_ms)],
        )?;
        tx.execute(
            r#"UPDATE speaker_turns SET "end" = ?1
               WHERE track = 'call' AND ("end" IS NULL OR "end" > ?1)"#,
            [to_i64(at_ms)],
        )?;
        tx.commit()
    }

    /// Stores segments from one stream session, and how far the session answered, at once.
    pub fn store_segments(
        &mut self,
        track: Track,
        epoch: u64,
        rows: &[StoredSegment],
        answered_ms: u64,
    ) -> rusqlite::Result<()> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        for s in rows {
            tx.execute(
                r#"INSERT OR REPLACE INTO stream_segments
                   (track, epoch, n, label, text, start, "end", timed)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"#,
                params![
                    track.as_str(),
                    to_i64(epoch),
                    to_i64(s.n),
                    s.label,
                    s.text,
                    to_i64(s.start),
                    to_i64(s.end),
                    s.timed
                ],
            )?;
        }
        raise(&tx, &answered_key(track), answered_ms)?;
        tx.commit()
    }

    /// The stored segments of `track` that overlap `[from_ms, to_ms)`, in the order they came.
    pub fn segments(
        &self,
        track: Track,
        from_ms: u64,
        to_ms: u64,
    ) -> rusqlite::Result<Vec<StoredSegment>> {
        self.query_segments(
            r#"WHERE track = ?1 AND start < ?3 AND "end" > ?2"#,
            params![track.as_str(), to_i64(from_ms), to_i64(to_ms)],
        )
    }

    /// The stored segments of `track` that came after `(epoch, n)`, in the order they came.
    pub fn segments_after(
        &self,
        track: Track,
        epoch: u64,
        n: u64,
    ) -> rusqlite::Result<Vec<StoredSegment>> {
        self.query_segments(
            "WHERE track = ?1 AND (epoch > ?2 OR (epoch = ?2 AND n > ?3))",
            params![track.as_str(), to_i64(epoch), to_i64(n)],
        )
    }

    /// Where the last stored segment of `track` ends, in meeting ms: how far the stream
    /// demonstrably answered.
    pub fn segments_end(&self, track: Track) -> rusqlite::Result<Option<u64>> {
        self.conn
            .query_row(
                r#"SELECT MAX("end") FROM stream_segments WHERE track = ?1"#,
                params![track.as_str()],
                |row| row.get::<_, Option<i64>>(0),
            )
            .map(|end| end.map(to_u64))
    }

    fn query_segments(
        &self,
        filter: &str,
        args: impl rusqlite::Params,
    ) -> rusqlite::Result<Vec<StoredSegment>> {
        let mut statement = self.conn.prepare(&format!(
            r#"SELECT track, epoch, n, label, text, start, "end", timed FROM stream_segments
               {filter} ORDER BY epoch, n"#
        ))?;
        let rows = statement.query_map(args, |row| {
            let track: String = row.get(0)?;
            Ok(StoredSegment {
                track: Track::parse(&track).unwrap_or(Track::Mic),
                epoch: to_u64(row.get(1)?),
                n: to_u64(row.get(2)?),
                label: row.get(3)?,
                text: row.get(4)?,
                start: to_u64(row.get(5)?),
                end: to_u64(row.get(6)?),
                timed: row.get(7)?,
            })
        })?;
        rows.collect()
    }

    /// Drops the segments of a session that start at or after `from_ms`: a session that broke
    /// off is fed again from there.
    pub fn drop_segments_from(
        &mut self,
        track: Track,
        epoch: u64,
        from_ms: u64,
    ) -> rusqlite::Result<()> {
        self.conn.execute(
            "DELETE FROM stream_segments WHERE track = ?1 AND epoch = ?2 AND start >= ?3",
            params![track.as_str(), to_i64(epoch), to_i64(from_ms)],
        )?;
        Ok(())
    }

    /// Call passages without a speaker that start at or after `from_ms` and end by `to_ms`, by
    /// start.
    pub fn null_call_passages(
        &self,
        from_ms: u64,
        to_ms: u64,
    ) -> rusqlite::Result<Vec<StoredPassage>> {
        // The pipeline asks every step, so the store filters rather than reading every passage.
        self.query_passages(
            r#"WHERE track = 'call' AND speaker IS NULL AND start >= ?1 AND "end" <= ?2"#,
            params![to_i64(from_ms), to_i64(to_ms)],
        )
    }

    /// Every passage, in the order of their start.
    pub fn passages(&self) -> rusqlite::Result<Vec<StoredPassage>> {
        self.query_passages("", [])
    }

    fn query_passages(
        &self,
        filter: &str,
        args: impl rusqlite::Params,
    ) -> rusqlite::Result<Vec<StoredPassage>> {
        let mut statement = self.conn.prepare(&format!(
            r#"SELECT id, track, speaker, start, "end", text, revision, dictation, language, tokens
               FROM passages {filter} ORDER BY start, track"#
        ))?;
        let rows = statement.query_map(args, |row| {
            let track: String = row.get(1)?;
            let tokens: Option<String> = row.get(9)?;
            Ok(StoredPassage {
                passage: Passage {
                    id: row.get(0)?,
                    track: Track::parse(&track).unwrap_or(Track::Mic),
                    speaker: row.get(2)?,
                    start: to_u64(row.get(3)?),
                    end: to_u64(row.get(4)?),
                    text: row.get(5)?,
                    revision: to_u64(row.get(6)?),
                    dictation: row.get(7)?,
                    language: row.get(8)?,
                },
                tokens: tokens.as_deref().map(decode_tokens).unwrap_or_default(),
            })
        })?;
        rows.collect()
    }

    /// Replaces a passage's dictation flag and revision.
    pub fn update_passage(&self, passage: &Passage) -> rusqlite::Result<()> {
        self.conn.execute(
            "UPDATE passages SET dictation = ?2, revision = ?3, speaker = ?4, text = ?5 WHERE id = ?1",
            params![
                passage.id,
                passage.dictation,
                to_i64(passage.revision),
                passage.speaker,
                passage.text
            ],
        )?;
        Ok(())
    }

    pub fn save_speaker(&self, speaker: &Speaker) -> rusqlite::Result<()> {
        self.save_json("speakers", &speaker.id, speaker)
    }

    pub fn save_mark(&self, mark: &Mark) -> rusqlite::Result<()> {
        self.save_json("marks", &mark.id, mark)
    }

    fn save_json(
        &self,
        table: &str,
        id: &str,
        value: &impl serde::Serialize,
    ) -> rusqlite::Result<()> {
        let data = serde_json::to_string(value).expect("protocol types serialize");
        self.conn.execute(
            &format!("INSERT OR REPLACE INTO {table} (id, data) VALUES (?1, ?2)"),
            params![id, data],
        )?;
        Ok(())
    }

    /// The marks stored so far, in the order of their time.
    pub fn marks(&self) -> rusqlite::Result<Vec<Mark>> {
        let mut statement = self.conn.prepare("SELECT data FROM marks")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        let mut marks: Vec<Mark> = Vec::new();
        for data in rows {
            if let Ok(mark) = serde_json::from_str(&data?) {
                marks.push(mark);
            }
        }
        marks.sort_by(|a: &Mark, b: &Mark| a.at.cmp(&b.at).then_with(|| a.id.cmp(&b.id)));
        Ok(marks)
    }

    /// The keys of the events already in the event log, with their sequence numbers.
    pub fn emitted(&self) -> rusqlite::Result<HashMap<String, u64>> {
        let mut statement = self.conn.prepare("SELECT key, seq FROM emitted")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, to_u64(row.get(1)?)))
        })?;
        rows.collect()
    }

    pub fn record_emitted(&self, key: &str, seq: u64) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO emitted (key, seq) VALUES (?1, ?2)",
            params![key, to_i64(seq)],
        )?;
        Ok(())
    }

    /// Makes the emitted keys exactly `keys`: what the event log holds for this meeting.
    pub fn set_emitted(&mut self, keys: &HashMap<String, u64>) -> rusqlite::Result<()> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute("DELETE FROM emitted", [])?;
        {
            let mut insert = tx.prepare("INSERT INTO emitted (key, seq) VALUES (?1, ?2)")?;
            for (key, seq) in keys {
                insert.execute(params![key, to_i64(*seq)])?;
            }
        }
        tx.commit()
    }

    /// The end of the recording, once the pipeline saw it, and what came of it.
    pub fn outcome(&self) -> rusqlite::Result<Option<Outcome>> {
        read_outcome(&self.conn)
    }

    pub fn set_outcome(&mut self, outcome: &Outcome) -> rusqlite::Result<()> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let set = |key: &str, value: Option<String>| -> rusqlite::Result<()> {
            match value {
                Some(value) => tx.execute(
                    "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)",
                    params![key, value],
                ),
                None => tx.execute("DELETE FROM meta WHERE key = ?1", [key]),
            }
            .map(drop)
        };
        set("state", Some(outcome.state.as_str().to_owned()))?;
        set("at", Some(outcome.at.to_string()))?;
        set("endedAt", Some(outcome.ended_at.to_string()))?;
        set("reason", outcome.reason.clone())?;
        set("doneAt", outcome.done_at.map(|t| t.to_string()))?;
        tx.commit()
    }
}

/// The outcome stored in a meeting folder's `transcript.db`, without creating the file.
pub fn stored_outcome(meeting_dir: &Path) -> Option<Outcome> {
    let path = meeting_dir.join(FILE_NAME);
    if !path.is_file() {
        return None;
    }
    let conn = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    conn.busy_timeout(Duration::from_secs(2)).ok()?;
    read_outcome(&conn).ok().flatten()
}

fn read_outcome(conn: &Connection) -> rusqlite::Result<Option<Outcome>> {
    let has_meta: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta')",
        [],
        |row| row.get(0),
    )?;
    if !has_meta {
        return Ok(None);
    }
    let mut statement = conn.prepare("SELECT key, value FROM meta")?;
    let meta: HashMap<String, String> = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let number = |key: &str| meta.get(key).and_then(|v| v.parse::<u64>().ok());
    let Some(state) = meta.get("state").and_then(|s| MeetingState::parse(s)) else {
        return Ok(None);
    };
    Ok(Some(Outcome {
        state,
        at: number("at").unwrap_or(0),
        ended_at: number("endedAt").unwrap_or(0),
        reason: meta.get("reason").cloned(),
        done_at: number("doneAt"),
    }))
}

/// Sets a numeric meta value unless the stored one is higher; returns what it holds now.
fn raise(conn: &Connection, key: &str, value: u64) -> rusqlite::Result<u64> {
    let stored: Option<String> = conn
        .query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| {
            row.get(0)
        })
        .optional()?;
    let stored = stored.and_then(|v| v.parse::<u64>().ok());
    if stored.is_some_and(|s| s >= value) {
        return Ok(stored.unwrap_or(value));
    }
    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)",
        params![key, value.to_string()],
    )?;
    Ok(value)
}

fn insert_passage(tx: &rusqlite::Transaction<'_>, p: &StoredPassage) -> rusqlite::Result<()> {
    let passage = &p.passage;
    let tokens = (!p.tokens.is_empty()).then(|| encode_tokens(&p.tokens));
    tx.execute(
        r#"INSERT OR REPLACE INTO passages
           (id, track, speaker, start, "end", text, revision, dictation, language, tokens)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)"#,
        params![
            passage.id,
            passage.track.as_str(),
            passage.speaker,
            to_i64(passage.start),
            to_i64(passage.end),
            passage.text,
            to_i64(passage.revision),
            passage.dictation,
            passage.language,
            tokens
        ],
    )?;
    Ok(())
}

/// Ownkey's token format: `[[text, start, end], ...]` in seconds, rounded to 10 ms.
fn encode_tokens(tokens: &[Token]) -> String {
    let round = |s: f64| (s * 100.0).round() / 100.0;
    let list: Vec<Value> = tokens
        .iter()
        .map(|t| serde_json::json!([t.text, round(t.start), round(t.end)]))
        .collect();
    Value::Array(list).to_string()
}

fn decode_tokens(text: &str) -> Vec<Token> {
    let Ok(Value::Array(list)) = serde_json::from_str::<Value>(text) else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|item| {
            Some(Token {
                text: item.get(0)?.as_str()?.to_owned(),
                start: item.get(1)?.as_f64()?,
                end: item.get(2)?.as_f64()?,
            })
        })
        .collect()
}

fn to_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn to_u64(value: i64) -> u64 {
    u64::try_from(value).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    fn passage(track: Track, start: u64, text: &str) -> StoredPassage {
        StoredPassage {
            passage: Passage {
                id: String::new(),
                track,
                speaker: Some("mic".into()),
                start,
                end: start + 1000,
                text: text.into(),
                revision: 1,
                dictation: false,
                language: None,
            },
            tokens: vec![Token {
                text: " Hi".into(),
                start: start as f64 / 1000.0,
                end: start as f64 / 1000.0 + 0.123,
            }],
        }
    }

    #[test]
    fn windows_move_the_cursor_with_their_passages() {
        let tmp = TempDir::new("transcript");
        let mut t = Transcript::open(tmp.path()).unwrap();
        assert_eq!(t.cursor(Track::Mic).unwrap(), 0);
        let stored = t
            .commit_window(
                Track::Mic,
                0,
                48_000,
                "pause",
                vec![passage(Track::Mic, 1_000, "a")],
            )
            .unwrap()
            .unwrap();
        assert_eq!(stored[0].passage.id, "mic-000001000");
        assert_eq!(t.cursor(Track::Mic).unwrap(), 48_000);
        assert_eq!(t.cursor(Track::Call).unwrap(), 0);
        // A second pipeline with an old cursor changes nothing.
        assert!(t
            .commit_window(
                Track::Mic,
                0,
                10,
                "pause",
                vec![passage(Track::Mic, 2_000, "b")]
            )
            .unwrap()
            .is_none());
        // A start that is taken moves on by a millisecond.
        let stored = t
            .commit_window(
                Track::Mic,
                48_000,
                96_000,
                "silence",
                vec![passage(Track::Mic, 1_000, "c")],
            )
            .unwrap()
            .unwrap();
        assert_eq!(stored[0].passage.id, "mic-000001001");
        drop(t);

        let t = Transcript::open(tmp.path()).unwrap();
        assert_eq!(t.cursor(Track::Mic).unwrap(), 96_000);
        let all = t.passages().unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].passage.text, "a");
        assert_eq!(all[0].tokens[0].text, " Hi");
        assert!(
            (all[0].tokens[0].end - 1.12).abs() < 1e-9,
            "rounded to 10 ms"
        );
    }

    #[test]
    fn call_passages_without_a_speaker_by_time() {
        let tmp = TempDir::new("transcript-unlabelled");
        let mut t = Transcript::open(tmp.path()).unwrap();
        let with = |track: Track, start: u64, speaker: Option<&str>| {
            let mut p = passage(track, start, "x");
            p.passage.speaker = speaker.map(str::to_owned);
            p
        };
        t.commit_window(
            Track::Call,
            0,
            160_000,
            "pause",
            vec![
                with(Track::Call, 0, None),
                with(Track::Call, 2_000, Some("call-1")),
                with(Track::Call, 4_000, None),
            ],
        )
        .unwrap()
        .unwrap();
        t.commit_window(
            Track::Mic,
            0,
            160_000,
            "pause",
            vec![with(Track::Mic, 0, None)],
        )
        .unwrap()
        .unwrap();
        let starts = |from: u64, to: u64| -> Vec<u64> {
            t.null_call_passages(from, to)
                .unwrap()
                .iter()
                .map(|p| p.passage.start)
                .collect()
        };
        assert_eq!(starts(0, u64::MAX), [0, 4_000]);
        assert_eq!(starts(1, u64::MAX), [4_000], "from its start on");
        assert_eq!(starts(0, 4_999), [0], "ending by the limit");
        let found = t.null_call_passages(0, u64::MAX).unwrap();
        assert_eq!(found[0].tokens[0].text, " Hi");
    }

    fn row(speaker: &str, start: u64, end: Option<u64>, epoch: u64) -> TurnRow {
        TurnRow {
            speaker: speaker.into(),
            start,
            end,
            epoch,
        }
    }

    #[test]
    fn speaker_turns_open_close_and_end_at_the_settled_position() {
        let tmp = TempDir::new("transcript-turns");
        let mut t = Transcript::open(tmp.path()).unwrap();
        assert_eq!(t.next_epoch().unwrap(), 1);
        assert_eq!(
            t.open_epoch(Track::Call, "nemotron", 0, "start").unwrap(),
            1
        );
        assert_eq!(t.open_epoch(Track::Mic, "mistral", 0, "start").unwrap(), 2);
        t.record_labels(&LabelBatch {
            map: vec![MapRow {
                epoch: 1,
                label: "0".into(),
                speaker: "call-1".into(),
                how: "new".into(),
            }],
            turns: vec![row("call-1", 1_000, None, 1), row("call-2", 5_000, None, 1)],
            settled: Some(6_000),
        })
        .unwrap();
        // The open turn ends at the settled position.
        let turns = t.turns(Track::Call, 0, 10_000).unwrap();
        assert_eq!(
            turns,
            vec![
                Turn {
                    speaker: "call-1".into(),
                    start: 1_000,
                    end: 6_000
                },
                Turn {
                    speaker: "call-2".into(),
                    start: 5_000,
                    end: 6_000
                },
            ]
        );
        // Closing a turn fills its end; a lower settled position is ignored.
        t.record_labels(&LabelBatch {
            turns: vec![row("call-1", 1_000, Some(4_000), 1)],
            settled: Some(5_500),
            ..LabelBatch::default()
        })
        .unwrap();
        assert_eq!(t.meta_u64(SETTLED_KEY).unwrap(), Some(6_000));
        assert_eq!(t.turns(Track::Call, 4_500, 10_000).unwrap().len(), 1);
        assert_eq!(t.turns(Track::Call, 0, 10_000).unwrap()[0].end, 4_000);
        assert_eq!(t.speaker_map().unwrap()[&(1, "0".into())], "call-1");
        assert_eq!(t.highest_speaker_number().unwrap(), 1);

        // A stream that stopped at 4.5 s: turns past it end there, later ones go.
        t.record_labels(&LabelBatch {
            turns: vec![
                row("call-3", 4_700, Some(5_200), 1),
                row("call-4", 3_000, Some(6_000), 1),
            ],
            ..LabelBatch::default()
        })
        .unwrap();
        t.close_open_turns(4_500).unwrap();
        let turns = t.turns(Track::Call, 0, 10_000).unwrap();
        assert_eq!(turns.len(), 2, "{turns:?}");
        assert_eq!((turns[0].speaker.as_str(), turns[0].end), ("call-1", 4_000));
        assert_eq!((turns[1].speaker.as_str(), turns[1].end), ("call-4", 4_500));
        assert_eq!(t.epochs().unwrap()[0].reason, "start");
        assert_eq!(t.epochs().unwrap()[1].track, Track::Mic);
        assert_eq!(t.next_epoch().unwrap(), 3);
    }

    #[test]
    fn speaker_ids_and_meta() {
        let tmp = TempDir::new("transcript-speakers");
        let t = Transcript::open(tmp.path()).unwrap();
        for id in ["call-10", "mic", "call-2", "call-1"] {
            t.save_speaker(&Speaker {
                id: id.into(),
                track: if id == "mic" { Track::Mic } else { Track::Call },
                label: id.into(),
            })
            .unwrap();
        }
        assert_eq!(t.speaker_ids().unwrap(), ["call-1", "call-2", "call-10"]);
        assert_eq!(t.highest_speaker_number().unwrap(), 10);
        assert_eq!(t.meta_get(MODE_KEY).unwrap(), None);
        t.meta_set(MODE_KEY, "nemotron").unwrap();
        assert_eq!(t.meta_get(MODE_KEY).unwrap().as_deref(), Some("nemotron"));
        assert_eq!(t.meta_raise("x", 5).unwrap(), 5);
        assert_eq!(t.meta_raise("x", 3).unwrap(), 5);
        assert_eq!(call_number("call-7"), Some(7));
        assert_eq!(call_number("call-0"), None);
        assert_eq!(call_number("mic"), None);
        assert!(!t.has_passage_on(Track::Call).unwrap());
    }

    #[test]
    fn stream_segments_by_time_and_after_a_mark() {
        let tmp = TempDir::new("transcript-segments");
        let mut t = Transcript::open(tmp.path()).unwrap();
        let segment = |epoch: u64, n: u64, start: u64| StoredSegment {
            track: Track::Call,
            epoch,
            n,
            label: Some("s1".into()),
            text: format!("w{start}"),
            start,
            end: start + 500,
            timed: false,
        };
        t.store_segments(
            Track::Call,
            1,
            &[segment(1, 0, 0), segment(1, 1, 1_000), segment(1, 2, 2_000)],
            2_000,
        )
        .unwrap();
        assert_eq!(t.meta_u64(&answered_key(Track::Call)).unwrap(), Some(2_000));
        assert_eq!(t.segments(Track::Call, 900, 1_600).unwrap().len(), 1);
        assert_eq!(t.segments(Track::Mic, 0, 9_000).unwrap().len(), 0);
        let after: Vec<u64> = t
            .segments_after(Track::Call, 1, 0)
            .unwrap()
            .iter()
            .map(|s| s.n)
            .collect();
        assert_eq!(after, [1, 2]);
        // A session that broke off is fed again from where it answered.
        t.drop_segments_from(Track::Call, 1, 1_500).unwrap();
        t.store_segments(Track::Call, 2, &[segment(2, 0, 1_600)], 1_000)
            .unwrap();
        assert_eq!(
            t.meta_u64(&answered_key(Track::Call)).unwrap(),
            Some(2_000),
            "answered never moves back"
        );
        let all = t.segments_after(Track::Call, 0, 0).unwrap();
        let keys: Vec<(u64, u64)> = all.iter().map(|s| (s.epoch, s.n)).collect();
        assert_eq!(keys, [(1, 0), (1, 1), (2, 0)]);
        assert_eq!(all[2].text, "w1600");
    }

    #[test]
    fn emitted_keys_and_the_outcome_survive_a_reopen() {
        let tmp = TempDir::new("transcript-meta");
        let mut t = Transcript::open(tmp.path()).unwrap();
        assert_eq!(stored_outcome(tmp.path()), None);
        t.record_emitted("started", 3).unwrap();
        t.record_emitted("passage:mic-000000000:1", 4).unwrap();
        let outcome = Outcome {
            state: MeetingState::Done,
            at: 7_000,
            ended_at: 1_793_000_007_000,
            reason: Some("user".into()),
            done_at: Some(1_793_000_009_000),
        };
        t.set_outcome(&outcome).unwrap();
        drop(t);
        assert_eq!(stored_outcome(tmp.path()), Some(outcome));
        let mut t = Transcript::open(tmp.path()).unwrap();
        assert_eq!(t.emitted().unwrap().get("started"), Some(&3));
        let keep: HashMap<String, u64> = [("started".to_owned(), 3)].into();
        t.set_emitted(&keep).unwrap();
        assert_eq!(t.emitted().unwrap(), keep);
        assert_eq!(stored_outcome(&tmp.path().join("nothing")), None);
    }
}
