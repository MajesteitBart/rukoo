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

pub const FILE_NAME: &str = "transcript.db";

const SCHEMA_VERSION: i64 = 1;

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
"#;

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
        tx.commit()?;
        Ok(Some(stored))
    }

    /// Every passage, in the order of their start.
    pub fn passages(&self) -> rusqlite::Result<Vec<StoredPassage>> {
        let mut statement = self.conn.prepare(
            r#"SELECT id, track, speaker, start, "end", text, revision, dictation, language, tokens
               FROM passages ORDER BY start, track"#,
        )?;
        let rows = statement.query_map([], |row| {
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
