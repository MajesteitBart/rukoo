//! The crash-safe upload queue, `<data>/sync/queue.db` (spec 2.7).
//!
//! One row per version of a file (`UNIQUE (meeting, path, sha256)`), with the `RKV1` header stored
//! before the first byte goes up, so a retry or a resumed multipart upload sends the same bytes.
//! The queue holds headers, whose data keys only the master key opens, and never the master key,
//! the secret or plaintext.
//!
//! Beyond spec 2.7's schema, `meetings` keeps three columns for the worker: `state` (the meeting's
//! `live`, `processing`, `done` or `failed` for its manifest and the index), `uploaded_gen` (the
//! newest manifest that reached the bucket) and `manifest_at` (when the last manifest was made).
//! A manifest row keeps its `gen` in `seq`.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

use crate::manifest::ManifestFile;
use crate::s3::Part;
use crate::{SyncError, SyncErrorKind};

/// The queue's file in `<data>/sync`.
pub const QUEUE_FILE: &str = "queue.db";

/// `PRAGMA user_version` of this schema. `open` refuses a newer one.
pub const SCHEMA_VERSION: i64 = 1;

/// The kinds retention holds and bucket retention removes: the meeting's media.
pub const MEDIA_KINDS: [&str; 3] = ["audio", "frame", "video"];

/// Media restored from the bucket stays at least this long after its last use (2.10).
pub const RESTORED_HOLD_MS: u64 = 24 * 60 * 60 * 1000;

/// The `errors` table keeps this many.
const ERRORS_KEPT: i64 = 20;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meetings (
  id               TEXT PRIMARY KEY,
  mhash            TEXT NOT NULL,
  phase            TEXT NOT NULL,
  title            TEXT,
  created_at       INTEGER,
  duration_ms      INTEGER,
  done_at          INTEGER,
  manifest_gen     INTEGER NOT NULL DEFAULT 0,
  manifest_dirty   INTEGER NOT NULL DEFAULT 0,
  media_removed_at INTEGER,
  scanned_at       INTEGER NOT NULL DEFAULT 0,
  state            TEXT,
  uploaded_gen     INTEGER NOT NULL DEFAULT 0,
  manifest_at      INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS files (
  id         INTEGER PRIMARY KEY,
  meeting    TEXT NOT NULL,
  path       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  lane       INTEGER NOT NULL,
  size       INTEGER NOT NULL,
  mtime      INTEGER,
  sha256     TEXT NOT NULL,
  object     TEXT NOT NULL,
  header     BLOB,
  source     TEXT,
  track TEXT, seq INTEGER, t INTEGER, samples INTEGER,
  state      TEXT NOT NULL,
  upload_id  TEXT,
  part_size  INTEGER,
  attempts   INTEGER NOT NULL DEFAULT 0,
  next_at    INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  done_at    INTEGER,
  UNIQUE (meeting, path, sha256)
);
CREATE INDEX IF NOT EXISTS files_next ON files (state, lane, next_at);
CREATE INDEX IF NOT EXISTS files_meeting ON files (meeting, path);
CREATE TABLE IF NOT EXISTS parts (
  file   INTEGER NOT NULL,
  number INTEGER NOT NULL,
  etag   TEXT NOT NULL,
  size   INTEGER NOT NULL,
  PRIMARY KEY (file, number)
);
CREATE TABLE IF NOT EXISTS restored (
  meeting     TEXT NOT NULL,
  path        TEXT NOT NULL,
  restored_at INTEGER NOT NULL,
  used_at     INTEGER NOT NULL,
  PRIMARY KEY (meeting, path)
);
CREATE TABLE IF NOT EXISTS errors (at INTEGER NOT NULL, code TEXT NOT NULL, message TEXT NOT NULL);
"#;

/// The columns [`Row`] reads, in order.
const ROW_COLUMNS: &str = "f.id, f.meeting, f.path, f.kind, f.lane, f.size, f.sha256, f.object, \
     f.header, f.source, f.state, f.upload_id, f.part_size, f.attempts, f.next_at";

/// The order rows go up in (2.9): lanes 0, 1, 2; lane 2 newest meeting first; in a meeting
/// `meeting.json`, then audio before frames, then the rest, the manifest last.
const ROW_ORDER: &str = "f.lane, \
     CASE WHEN f.lane = 2 THEN f.meeting ELSE '' END DESC, \
     CASE f.kind WHEN 'meeting' THEN 0 WHEN 'audio' THEN 1 WHEN 'frame' THEN 2 \
       WHEN 'manifest' THEN 4 WHEN 'index' THEN 5 ELSE 3 END, \
     f.id";

pub struct Queue {
    conn: Mutex<Connection>,
    writer: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RowState {
    Waiting,
    Uploading,
    Done,
    Gone,
    Removed,
    Lost,
}

impl RowState {
    pub fn as_str(self) -> &'static str {
        match self {
            RowState::Waiting => "waiting",
            RowState::Uploading => "uploading",
            RowState::Done => "done",
            RowState::Gone => "gone",
            RowState::Removed => "removed",
            RowState::Lost => "lost",
        }
    }

    pub fn parse(name: &str) -> Option<RowState> {
        Some(match name {
            "waiting" => RowState::Waiting,
            "uploading" => RowState::Uploading,
            "done" => RowState::Done,
            "gone" => RowState::Gone,
            "removed" => RowState::Removed,
            "lost" => RowState::Lost,
            _ => return None,
        })
    }
}

/// A row of `files`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Row {
    pub id: i64,
    pub meeting: String,
    pub path: String,
    pub kind: String,
    pub lane: u8,
    pub size: u64,
    pub sha256: String,
    pub object: String,
    pub header: Option<Vec<u8>>,
    pub source: Option<PathBuf>,
    pub state: RowState,
    pub upload_id: Option<String>,
    pub part_size: Option<u64>,
    pub attempts: u32,
    pub next_at: u64,
}

/// The columns of `files` that a scan fills.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewRow {
    pub meeting: String,
    /// Relative to the meeting folder with forward slashes; `manifest` or `index` for those.
    pub path: String,
    /// `meeting`, `audio`, `frame`, `video`, `screen`, `timeline`, `transcript`, `manifest` or
    /// `index`.
    pub kind: String,
    /// 0 live, 1 after, 2 backfill.
    pub lane: u8,
    /// Plaintext bytes.
    pub size: u64,
    pub mtime: Option<u64>,
    /// Plaintext SHA-256, hex.
    pub sha256: String,
    /// The object's key without the user's prefix.
    pub object: String,
    /// The 115-byte `RKV1` header.
    pub header: Vec<u8>,
    /// Staged plaintext under `sync/staging`; `None` for the meeting's own file.
    pub source: Option<PathBuf>,
    pub track: Option<String>,
    /// The segment's number for audio; the manifest's `gen` for a manifest.
    pub seq: Option<u64>,
    pub t: Option<u64>,
    pub samples: Option<u64>,
    pub created_at: u64,
}

/// A row of `meetings`, for the worker.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MeetingRow {
    pub(crate) id: String,
    pub(crate) mhash: String,
    /// live | after | synced | restored | forgotten
    pub(crate) phase: String,
    pub(crate) title: String,
    pub(crate) created_at: u64,
    pub(crate) duration_ms: Option<u64>,
    pub(crate) done_at: Option<u64>,
    pub(crate) manifest_gen: u64,
    pub(crate) manifest_dirty: bool,
    pub(crate) media_removed_at: Option<u64>,
    /// live | processing | done | failed
    pub(crate) state: String,
    pub(crate) uploaded_gen: u64,
    pub(crate) manifest_at: u64,
}

const MEETING_COLUMNS: &str = "id, mhash, phase, title, created_at, duration_ms, done_at, \
     manifest_gen, manifest_dirty, media_removed_at, state, uploaded_gen, manifest_at";

/// What the scan learned about a meeting.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Progress<'a> {
    pub(crate) phase: &'a str,
    pub(crate) state: &'a str,
    pub(crate) duration_ms: Option<u64>,
    pub(crate) done_at: Option<u64>,
}

/// A meeting a restore brings back.
pub(crate) struct Import<'a> {
    pub(crate) meeting: &'a str,
    pub(crate) mhash: &'a str,
    pub(crate) title: &'a str,
    pub(crate) created_at: u64,
    pub(crate) duration_ms: Option<u64>,
    pub(crate) state: &'a str,
    pub(crate) gen: u64,
    pub(crate) media_removed_at: Option<u64>,
    pub(crate) files: &'a [ManifestFile],
    pub(crate) now: u64,
}

impl Queue {
    pub fn open(sync_dir: &Path) -> Result<Queue, SyncError> {
        fs::create_dir_all(sync_dir).map_err(|e| local("Voice can't make its sync folder", &e))?;
        let path = sync_dir.join(QUEUE_FILE);
        let mut conn = Connection::open(&path).map_err(db)?;
        conn.query_row("PRAGMA journal_mode=WAL", [], |row| row.get::<_, String>(0))
            .map_err(db)?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(db)?;
        conn.busy_timeout(Duration::from_secs(5)).map_err(db)?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db)?;
        let version: i64 = tx
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(db)?;
        if version > SCHEMA_VERSION {
            return Err(SyncError::new(
                SyncErrorKind::Local,
                format!("queue.db has schema version {version}, from a newer Voice"),
            ));
        }
        tx.execute_batch(SCHEMA).map_err(db)?;
        tx.pragma_update(None, "user_version", SCHEMA_VERSION)
            .map_err(db)?;
        let writer: Option<String> = tx
            .query_row("SELECT value FROM meta WHERE key = 'writer'", [], |row| {
                row.get(0)
            })
            .optional()
            .map_err(db)?;
        let writer = match writer {
            Some(writer) => writer,
            None => {
                let writer = random_hex(16)?;
                tx.execute(
                    "INSERT INTO meta (key, value) VALUES ('writer', ?1)",
                    [&writer],
                )
                .map_err(db)?;
                writer
            }
        };
        tx.commit().map_err(db)?;
        Ok(Queue {
            conn: Mutex::new(conn),
            writer,
        })
    }

    /// Runs `f` on the connection. A poisoned lock is an error: a broken queue never lets media go.
    fn with<T>(
        &self,
        f: impl FnOnce(&mut Connection) -> rusqlite::Result<T>,
    ) -> Result<T, SyncError> {
        let mut conn = self.conn.lock().map_err(|_: PoisonError<_>| {
            SyncError::new(SyncErrorKind::Local, "The sync queue's lock is poisoned.")
        })?;
        f(&mut conn).map_err(db)
    }

    /// 32 hex characters naming this data folder's index (2.4).
    pub fn writer(&self) -> String {
        self.writer.clone()
    }

    pub fn ensure_meeting(
        &self,
        id: &str,
        mhash: &str,
        title: &str,
        created_at: u64,
    ) -> Result<(), SyncError> {
        self.with(|c| {
            c.execute(
                "INSERT INTO meetings (id, mhash, phase, title, created_at) \
                 VALUES (?1, ?2, 'after', ?3, ?4) \
                 ON CONFLICT (id) DO UPDATE SET mhash = excluded.mhash, title = excluded.title, \
                   created_at = excluded.created_at, \
                   phase = CASE phase WHEN 'forgotten' THEN 'after' ELSE phase END",
                params![id, mhash, title, to_i64(created_at)],
            )
            .map(drop)
        })
    }

    /// Size, modification time and SHA-256 of the newest row for this file. Rows marked `gone`
    /// don't count: their file changed before it went up.
    pub fn known(
        &self,
        meeting: &str,
        path: &str,
    ) -> Result<Option<(u64, Option<u64>, String)>, SyncError> {
        self.with(|c| {
            c.query_row(
                "SELECT size, mtime, sha256 FROM files \
                 WHERE meeting = ?1 AND path = ?2 AND state != 'gone' ORDER BY id DESC LIMIT 1",
                params![meeting, path],
                |r| {
                    Ok((
                        to_u64(r.get(0)?),
                        r.get::<_, Option<i64>>(1)?.map(to_u64),
                        r.get(2)?,
                    ))
                },
            )
            .optional()
        })
    }

    /// INSERT OR IGNORE; true when a row was added. A version that went `gone` (its file changed
    /// before it went up) comes back as waiting when the same bytes return, with its own header.
    pub fn insert(&self, row: NewRow) -> Result<bool, SyncError> {
        self.with(|c| {
            let n = c.execute(
                "INSERT INTO files (meeting, path, kind, lane, size, mtime, sha256, \
                   object, header, source, track, seq, t, samples, state, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 'waiting', ?15) \
                 ON CONFLICT (meeting, path, sha256) DO UPDATE SET state = 'waiting', \
                   attempts = 0, next_at = 0, lane = excluded.lane, mtime = excluded.mtime, \
                   source = excluded.source, created_at = excluded.created_at \
                 WHERE files.state = 'gone'",
                params![
                    row.meeting,
                    row.path,
                    row.kind,
                    i64::from(row.lane),
                    to_i64(row.size),
                    row.mtime.map(to_i64),
                    row.sha256,
                    row.object,
                    row.header,
                    row.source.as_deref().map(path_text),
                    row.track,
                    row.seq.map(to_i64),
                    row.t.map(to_i64),
                    row.samples.map(to_i64),
                    to_i64(row.created_at),
                ],
            )?;
            Ok(n == 1)
        })
    }

    /// The row that goes up next at `now`. While a meeting is live (`live_only`), only lane-0
    /// rows of live meetings (2.9).
    pub fn next(&self, now: u64, live_only: bool) -> Result<Option<Row>, SyncError> {
        self.with(|c| {
            c.query_row(
                &format!(
                    "SELECT {ROW_COLUMNS} FROM files f LEFT JOIN meetings m ON m.id = f.meeting \
                     WHERE f.state IN ('waiting', 'uploading') AND f.next_at <= ?1 \
                       AND (?2 = 0 OR (f.lane = 0 AND m.phase = 'live')) \
                     ORDER BY {ROW_ORDER} LIMIT 1"
                ),
                params![to_i64(now), live_only],
                row_from,
            )
            .optional()
        })
    }

    /// When the earliest row that waits for its retry may go, for the worker's sleep.
    pub(crate) fn next_due(&self, live_only: bool) -> Result<Option<u64>, SyncError> {
        self.with(|c| {
            c.query_row(
                "SELECT MIN(f.next_at) FROM files f LEFT JOIN meetings m ON m.id = f.meeting \
                 WHERE f.state IN ('waiting', 'uploading') \
                   AND (?1 = 0 OR (f.lane = 0 AND m.phase = 'live'))",
                [live_only],
                |r| Ok(r.get::<_, Option<i64>>(0)?.map(to_u64)),
            )
        })
    }

    /// Stores a multipart upload's id and part size before any part goes up; `None` forgets the
    /// upload and its parts.
    pub fn set_upload(
        &self,
        file: i64,
        upload_id: Option<&str>,
        part_size: Option<u64>,
    ) -> Result<(), SyncError> {
        self.with(|c| {
            let tx = c.transaction()?;
            tx.execute(
                "UPDATE files SET upload_id = ?2, part_size = ?3, \
                   state = CASE WHEN state IN ('waiting', 'uploading') THEN \
                     CASE WHEN ?2 IS NULL THEN 'waiting' ELSE 'uploading' END ELSE state END \
                 WHERE id = ?1",
                params![file, upload_id, part_size.map(to_i64)],
            )?;
            if upload_id.is_none() {
                tx.execute("DELETE FROM parts WHERE file = ?1", [file])?;
            }
            tx.commit()
        })
    }

    pub fn part_done(
        &self,
        file: i64,
        number: u16,
        etag: &str,
        size: u64,
    ) -> Result<(), SyncError> {
        self.with(|c| {
            c.execute(
                "INSERT OR REPLACE INTO parts (file, number, etag, size) VALUES (?1, ?2, ?3, ?4)",
                params![file, i64::from(number), etag, to_i64(size)],
            )
            .map(drop)
        })
    }

    /// What ListParts found replaces what the queue knew.
    pub fn replace_parts(&self, file: i64, parts: &[Part]) -> Result<(), SyncError> {
        self.with(|c| {
            let tx = c.transaction()?;
            tx.execute("DELETE FROM parts WHERE file = ?1", [file])?;
            for part in parts {
                tx.execute(
                    "INSERT OR REPLACE INTO parts (file, number, etag, size) VALUES (?1, ?2, ?3, ?4)",
                    params![file, i64::from(part.number), part.etag, to_i64(part.size)],
                )?;
            }
            tx.commit()
        })
    }

    pub fn parts(&self, file: i64) -> Result<Vec<Part>, SyncError> {
        self.with(|c| {
            let mut stmt =
                c.prepare("SELECT number, etag, size FROM parts WHERE file = ?1 ORDER BY number")?;
            let parts = stmt
                .query_map([file], |r| {
                    Ok(Part {
                        number: u16::try_from(r.get::<_, i64>(0)?).unwrap_or(u16::MAX),
                        etag: r.get(1)?,
                        size: to_u64(r.get(2)?),
                    })
                })?
                .collect();
            parts
        })
    }

    /// The row reached the bucket. Its meeting needs a new manifest; a manifest's `gen` becomes the
    /// meeting's uploaded one.
    pub fn done(&self, file: i64, now: u64) -> Result<(), SyncError> {
        self.with(|c| {
            let tx = c.transaction()?;
            tx.execute(
                "UPDATE files SET state = 'done', done_at = ?2, upload_id = NULL, last_error = NULL \
                 WHERE id = ?1",
                params![file, to_i64(now)],
            )?;
            tx.execute("DELETE FROM parts WHERE file = ?1", [file])?;
            tx.execute(
                "UPDATE meetings SET manifest_dirty = 1 WHERE id = \
                   (SELECT meeting FROM files WHERE id = ?1 AND kind NOT IN ('manifest', 'index'))",
                [file],
            )?;
            tx.execute(
                "UPDATE meetings SET uploaded_gen = MAX(uploaded_gen, \
                   (SELECT IFNULL(seq, 0) FROM files WHERE id = ?1)) \
                 WHERE id = (SELECT meeting FROM files WHERE id = ?1 AND kind = 'manifest')",
                [file],
            )?;
            tx.commit()
        })
    }

    /// Counts a failed attempt and sets when the row may go again.
    pub fn retry(&self, file: i64, next_at: u64, error: &SyncError) -> Result<(), SyncError> {
        self.with(|c| {
            c.execute(
                "UPDATE files SET attempts = attempts + 1, next_at = ?2, last_error = ?3 WHERE id = ?1",
                params![file, to_i64(next_at), error.message],
            )
            .map(drop)
        })
    }

    /// The file changed or vanished before it went up: the next scan makes a new row. An open
    /// multipart upload stays named so the worker can abort it.
    pub fn gone(&self, file: i64) -> Result<(), SyncError> {
        self.with(|c| {
            let tx = c.transaction()?;
            tx.execute(
                "UPDATE files SET state = 'gone' WHERE id = ?1 AND state IN ('waiting', 'uploading')",
                [file],
            )?;
            tx.execute("DELETE FROM parts WHERE file = ?1", [file])?;
            tx.commit()
        })
    }

    /// Whether retention must keep the meeting's media (2.10):
    ///
    /// ```text
    /// ( sync_on and ( a row of kind audio, frame or video is waiting or uploading
    ///               or has_media and the meeting has no meetings row yet
    ///               or has_media and the meeting is live or still uploading (phase live or after) ) )
    /// or a restored row of the meeting was used in the last 24 hours
    /// ```
    ///
    /// The phase line covers files the scan hasn't reached yet: a meeting counts as synced only once
    /// everything it had went up.
    pub fn holds_media(
        &self,
        meeting: &str,
        sync_on: bool,
        has_media: bool,
        now: u64,
    ) -> Result<bool, SyncError> {
        self.with(|c| {
            let recent = now.saturating_sub(RESTORED_HOLD_MS);
            let restored: bool = c.query_row(
                "SELECT EXISTS (SELECT 1 FROM restored WHERE meeting = ?1 AND used_at > ?2)",
                params![meeting, to_i64(recent)],
                |r| r.get(0),
            )?;
            if restored {
                return Ok(true);
            }
            if !sync_on {
                return Ok(false);
            }
            let waiting: bool = c.query_row(
                "SELECT EXISTS (SELECT 1 FROM files WHERE meeting = ?1 \
                   AND kind IN ('audio', 'frame', 'video') AND state IN ('waiting', 'uploading'))",
                [meeting],
                |r| r.get(0),
            )?;
            if waiting {
                return Ok(true);
            }
            if !has_media {
                return Ok(false);
            }
            let phase: Option<String> = c
                .query_row("SELECT phase FROM meetings WHERE id = ?1", [meeting], |r| {
                    r.get(0)
                })
                .optional()?;
            Ok(match phase.as_deref() {
                None => true,
                Some("live" | "after") => true,
                Some(_) => false,
            })
        })
    }

    /// Whether the meeting has rows that never reached the bucket (waiting or uploading), or no
    /// row at all yet.
    pub fn has_waiting(&self, meeting: &str) -> Result<bool, SyncError> {
        self.with(|c| {
            c.query_row(
                "SELECT EXISTS (SELECT 1 FROM files WHERE meeting = ?1 \
                   AND kind NOT IN ('manifest', 'index') AND state IN ('waiting', 'uploading')) \
                 OR NOT EXISTS (SELECT 1 FROM meetings WHERE id = ?1)",
                [meeting],
                |r| r.get(0),
            )
        })
    }

    /// Marks the meeting's waiting and uploading rows of these kinds `lost`; how many (2.10).
    pub fn mark_lost(&self, meeting: &str, kinds: &[&str]) -> Result<u64, SyncError> {
        self.with(|c| {
            let tx = c.transaction()?;
            let mut n = 0;
            for kind in kinds {
                n += tx.execute(
                    "UPDATE files SET state = 'lost' WHERE meeting = ?1 AND kind = ?2 \
                       AND state IN ('waiting', 'uploading')",
                    params![meeting, kind],
                )?;
            }
            tx.execute(
                "DELETE FROM parts WHERE file IN (SELECT id FROM files WHERE state = 'lost')",
                [],
            )?;
            tx.commit()?;
            Ok(n as u64)
        })
    }

    pub fn lost(&self) -> Result<u64, SyncError> {
        self.with(|c| {
            c.query_row("SELECT COUNT(*) FROM files WHERE state = 'lost'", [], |r| {
                Ok(to_u64(r.get(0)?))
            })
        })
    }

    /// Files, bytes and the oldest created_at of what waits. Manifests and the index don't count.
    pub fn waiting(&self) -> Result<(u64, u64, Option<u64>), SyncError> {
        self.with(|c| {
            c.query_row(
                "SELECT COUNT(*), IFNULL(SUM(size), 0), MIN(created_at) FROM files \
                 WHERE state IN ('waiting', 'uploading') AND kind NOT IN ('manifest', 'index')",
                [],
                |r| {
                    Ok((
                        to_u64(r.get(0)?),
                        to_u64(r.get(1)?),
                        r.get::<_, Option<i64>>(2)?.map(to_u64),
                    ))
                },
            )
        })
    }

    /// Whether anything still has to reach the bucket: a row of any kind, a manifest that is out of
    /// date or an index that is due.
    pub(crate) fn pending(&self) -> Result<bool, SyncError> {
        self.with(|c| {
            c.query_row(
                "SELECT EXISTS (SELECT 1 FROM files WHERE state IN ('waiting', 'uploading')) \
                 OR EXISTS (SELECT 1 FROM meetings WHERE manifest_dirty = 1 AND phase != 'forgotten') \
                 OR EXISTS (SELECT 1 FROM meta WHERE key = 'index_due')",
                [],
                |r| r.get(0),
            )
        })
    }

    /// Keeps the newest 20.
    pub fn note_error(&self, at: u64, error: &SyncError) -> Result<(), SyncError> {
        self.with(|c| {
            let tx = c.transaction()?;
            tx.execute(
                "INSERT INTO errors (at, code, message) VALUES (?1, ?2, ?3)",
                params![to_i64(at), error.code(), error.message],
            )?;
            tx.execute(
                "DELETE FROM errors WHERE rowid NOT IN \
                   (SELECT rowid FROM errors ORDER BY at DESC, rowid DESC LIMIT ?1)",
                [ERRORS_KEPT],
            )?;
            tx.commit()
        })
    }

    /// The newest error: when, its code and its message.
    pub(crate) fn last_error(&self) -> Result<Option<(u64, String, String)>, SyncError> {
        self.with(|c| {
            c.query_row(
                "SELECT at, code, message FROM errors ORDER BY at DESC, rowid DESC LIMIT 1",
                [],
                |r| Ok((to_u64(r.get(0)?), r.get(1)?, r.get(2)?)),
            )
            .optional()
        })
    }

    /// A file a restore or a fetch wrote, or one that was read again: it stays at least 24 hours.
    pub fn restored(&self, meeting: &str, path: &str, now: u64) -> Result<(), SyncError> {
        self.with(|c| {
            c.execute(
                "INSERT INTO restored (meeting, path, restored_at, used_at) VALUES (?1, ?2, ?3, ?3) \
                 ON CONFLICT (meeting, path) DO UPDATE SET used_at = excluded.used_at",
                params![meeting, path, to_i64(now)],
            )
            .map(drop)
        })
    }

    /// Touches `used_at` of a restored file, when it is one.
    pub(crate) fn touch_restored(
        &self,
        meeting: &str,
        path: &str,
        now: u64,
    ) -> Result<(), SyncError> {
        self.with(|c| {
            c.execute(
                "UPDATE restored SET used_at = ?3 WHERE meeting = ?1 AND path = ?2",
                params![meeting, path, to_i64(now)],
            )
            .map(drop)
        })
    }

    /// Whether this computer uploaded anything with this kid (D5): a finished or removed object, or
    /// a part of one. Rows a restore imported (no header) were uploaded by another computer.
    pub fn uploaded_with(&self, kid: &str) -> Result<bool, SyncError> {
        let prefix = format!("rkv1/{kid}/%");
        self.with(|c| {
            c.query_row(
                "SELECT EXISTS (SELECT 1 FROM files WHERE object LIKE ?1 AND header IS NOT NULL \
                   AND state IN ('done', 'removed')) \
                 OR EXISTS (SELECT 1 FROM parts p JOIN files f ON f.id = p.file \
                   WHERE f.object LIKE ?1)",
                [&prefix],
                |r| r.get(0),
            )
        })
    }

    // The worker's own calls.

    pub(crate) fn meta(&self, key: &str) -> Result<Option<String>, SyncError> {
        self.with(|c| {
            c.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
                .optional()
        })
    }

    pub(crate) fn set_meta(&self, key: &str, value: Option<&str>) -> Result<(), SyncError> {
        self.with(|c| {
            match value {
                Some(value) => c.execute(
                    "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)",
                    params![key, value],
                ),
                None => c.execute("DELETE FROM meta WHERE key = ?1", [key]),
            }
            .map(drop)
        })
    }

    pub(crate) fn meta_u64(&self, key: &str) -> Result<Option<u64>, SyncError> {
        Ok(self.meta(key)?.and_then(|v| v.parse().ok()))
    }

    /// The rows were made with `kid`. With another key every row is useless: object names and
    /// headers come from the key, so the queue starts again. True when it did.
    pub(crate) fn adopt_kid(&self, kid: &str) -> Result<bool, SyncError> {
        self.with(|c| {
            let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let old: Option<String> = tx
                .query_row("SELECT value FROM meta WHERE key = 'kid'", [], |r| r.get(0))
                .optional()?;
            if old.as_deref() == Some(kid) {
                return Ok(false);
            }
            let reset = old.is_some();
            if reset {
                tx.execute_batch("DELETE FROM parts; DELETE FROM files; DELETE FROM meetings;")?;
            }
            tx.execute(
                "INSERT OR REPLACE INTO meta (key, value) VALUES ('kid', ?1)",
                [kid],
            )?;
            tx.commit()?;
            Ok(reset)
        })
    }

    pub(crate) fn meeting(&self, id: &str) -> Result<Option<MeetingRow>, SyncError> {
        self.with(|c| {
            c.query_row(
                &format!("SELECT {MEETING_COLUMNS} FROM meetings WHERE id = ?1"),
                [id],
                meeting_from,
            )
            .optional()
        })
    }

    pub(crate) fn meetings(&self) -> Result<Vec<MeetingRow>, SyncError> {
        self.meetings_where("1")
    }

    /// Meetings whose manifest is out of date.
    pub(crate) fn dirty_meetings(&self) -> Result<Vec<MeetingRow>, SyncError> {
        self.meetings_where("manifest_dirty = 1 AND phase != 'forgotten'")
    }

    fn meetings_where(&self, filter: &str) -> Result<Vec<MeetingRow>, SyncError> {
        self.with(|c| {
            let mut stmt = c.prepare(&format!(
                "SELECT {MEETING_COLUMNS} FROM meetings WHERE {filter} ORDER BY id DESC"
            ))?;
            let rows = stmt.query_map([], meeting_from)?.collect();
            rows
        })
    }

    pub(crate) fn set_progress(
        &self,
        id: &str,
        progress: &Progress<'_>,
        now: u64,
    ) -> Result<(), SyncError> {
        self.with(|c| {
            c.execute(
                "UPDATE meetings SET phase = ?2, state = ?3, duration_ms = ?4, \
                   done_at = IFNULL(?5, done_at), scanned_at = ?6 WHERE id = ?1",
                params![
                    id,
                    progress.phase,
                    progress.state,
                    progress.duration_ms.map(to_i64),
                    progress.done_at.map(to_i64),
                    to_i64(now)
                ],
            )
            .map(drop)
        })
    }

    pub(crate) fn set_phase(&self, id: &str, phase: &str) -> Result<(), SyncError> {
        self.with(|c| {
            c.execute(
                "UPDATE meetings SET phase = ?2 WHERE id = ?1",
                params![id, phase],
            )
            .map(drop)
        })
    }

    pub(crate) fn any_live(&self) -> Result<bool, SyncError> {
        self.with(|c| {
            c.query_row(
                "SELECT EXISTS (SELECT 1 FROM meetings WHERE phase = 'live')",
                [],
                |r| r.get(0),
            )
        })
    }

    /// A known file whose modification time changed but whose bytes didn't.
    pub(crate) fn set_mtime(
        &self,
        meeting: &str,
        path: &str,
        sha256: &str,
        mtime: u64,
    ) -> Result<(), SyncError> {
        self.with(|c| {
            c.execute(
                "UPDATE files SET mtime = ?4 WHERE meeting = ?1 AND path = ?2 AND sha256 = ?3",
                params![meeting, path, sha256, to_i64(mtime)],
            )
            .map(drop)
        })
    }

    /// Whether the meeting has rows that haven't gone up; its manifests count only `with_manifest`.
    pub(crate) fn meeting_waiting(
        &self,
        meeting: &str,
        with_manifest: bool,
    ) -> Result<bool, SyncError> {
        self.with(|c| {
            c.query_row(
                "SELECT EXISTS (SELECT 1 FROM files WHERE meeting = ?1 \
                   AND (?2 OR kind != 'manifest') AND state IN ('waiting', 'uploading'))",
                params![meeting, with_manifest],
                |r| r.get(0),
            )
        })
    }

    /// The newest finished row of each path of the meeting, manifests left out: what its manifest
    /// lists.
    pub(crate) fn manifest_rows(&self, meeting: &str) -> Result<Vec<ManifestFile>, SyncError> {
        self.with(|c| {
            let mut stmt = c.prepare(
                "SELECT path, kind, object, size, sha256, track, seq, t, samples FROM files f \
                 WHERE meeting = ?1 AND state = 'done' AND kind NOT IN ('manifest', 'index') \
                   AND id = (SELECT MAX(id) FROM files g WHERE g.meeting = f.meeting \
                     AND g.path = f.path AND g.state = 'done') \
                 ORDER BY id",
            )?;
            let rows = stmt
                .query_map([meeting], |r| {
                    Ok(ManifestFile {
                        path: r.get(0)?,
                        kind: r.get(1)?,
                        object: r.get(2)?,
                        size: to_u64(r.get(3)?),
                        sha256: r.get(4)?,
                        track: r.get(5)?,
                        seq: r.get::<_, Option<i64>>(6)?.map(to_u64),
                        t: r.get::<_, Option<i64>>(7)?.map(to_u64),
                        samples: r.get::<_, Option<i64>>(8)?.map(to_u64),
                    })
                })?
                .collect();
            rows
        })
    }

    /// Counts the meeting's manifest up: its new `gen`, and when bucket retention removed its media.
    pub(crate) fn start_manifest(
        &self,
        meeting: &str,
        now: u64,
    ) -> Result<(u64, Option<u64>), SyncError> {
        self.with(|c| {
            let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute(
                "UPDATE meetings SET manifest_gen = manifest_gen + 1, manifest_at = ?2 WHERE id = ?1",
                params![meeting, to_i64(now)],
            )?;
            let found = tx
                .query_row(
                    "SELECT manifest_gen, media_removed_at FROM meetings WHERE id = ?1",
                    [meeting],
                    |r| Ok((to_u64(r.get(0)?), r.get::<_, Option<i64>>(1)?.map(to_u64))),
                )
                .optional()?;
            tx.commit()?;
            Ok(found.unwrap_or((1, None)))
        })
    }

    pub(crate) fn set_manifest_dirty(&self, meeting: &str) -> Result<(), SyncError> {
        self.with(|c| {
            c.execute(
                "UPDATE meetings SET manifest_dirty = 1 WHERE id = ?1",
                [meeting],
            )
            .map(drop)
        })
    }

    /// A meeting with nothing in the bucket needs no manifest yet.
    pub(crate) fn clear_manifest_dirty(&self, meeting: &str) -> Result<(), SyncError> {
        self.with(|c| {
            c.execute(
                "UPDATE meetings SET manifest_dirty = 0 WHERE id = ?1",
                [meeting],
            )
            .map(drop)
        })
    }

    /// Rows of the same file older than its newest that still wait become `gone`: the newer
    /// version replaces them. Returns their staged files, to delete.
    pub(crate) fn supersede(&self, meeting: &str, path: &str) -> Result<Vec<PathBuf>, SyncError> {
        const OLDER: &str = "meeting = ?1 AND path = ?2 AND state IN ('waiting', 'uploading') \
             AND id < (SELECT MAX(id) FROM files g WHERE g.meeting = ?1 AND g.path = ?2)";
        self.with(|c| {
            let tx = c.transaction()?;
            let sources: Vec<PathBuf> = {
                let mut stmt = tx.prepare(&format!(
                    "SELECT source FROM files WHERE {OLDER} AND source IS NOT NULL"
                ))?;
                let sources = stmt
                    .query_map(params![meeting, path], |r| {
                        Ok(PathBuf::from(r.get::<_, String>(0)?))
                    })?
                    .collect::<rusqlite::Result<_>>()?;
                sources
            };
            tx.execute(
                &format!("UPDATE files SET state = 'gone' WHERE {OLDER}"),
                params![meeting, path],
            )?;
            tx.commit()?;
            Ok(sources)
        })
    }

    /// The meeting's finished rows, manifests left out.
    pub(crate) fn done_rows(&self, meeting: &str) -> Result<Vec<Row>, SyncError> {
        self.rows_where(
            "f.meeting = ?1 AND f.state = 'done' AND f.kind NOT IN ('manifest', 'index')",
            meeting,
        )
    }

    /// Every row of the meeting.
    pub(crate) fn rows_of(&self, meeting: &str) -> Result<Vec<Row>, SyncError> {
        self.rows_where("f.meeting = ?1", meeting)
    }

    fn rows_where(&self, filter: &str, meeting: &str) -> Result<Vec<Row>, SyncError> {
        self.with(|c| {
            let mut stmt = c.prepare(&format!(
                "SELECT {ROW_COLUMNS} FROM files f WHERE {filter} ORDER BY f.id"
            ))?;
            let rows = stmt.query_map([meeting], row_from)?.collect();
            rows
        })
    }

    /// Rows whose object bucket retention or a newer version removed from the bucket.
    pub(crate) fn mark_removed(&self, ids: &[i64]) -> Result<(), SyncError> {
        self.with(|c| {
            let tx = c.transaction()?;
            for id in ids {
                tx.execute(
                    "UPDATE files SET state = 'removed' WHERE id = ?1 AND state != 'removed'",
                    [id],
                )?;
                tx.execute("DELETE FROM parts WHERE file = ?1", [id])?;
            }
            tx.commit()
        })
    }

    /// Bucket retention removed the meeting's media: its next manifest says so.
    pub(crate) fn set_media_removed(&self, meeting: &str, at: u64) -> Result<(), SyncError> {
        self.with(|c| {
            c.execute(
                "UPDATE meetings SET media_removed_at = ?2, manifest_dirty = 1 WHERE id = ?1",
                params![meeting, to_i64(at)],
            )
            .map(drop)
        })
    }

    /// Meetings whose media bucket retention removes: done before `cutoff`, with media rows that
    /// are in the bucket or waiting.
    pub(crate) fn expired_media(&self, cutoff: u64) -> Result<Vec<(String, Vec<Row>)>, SyncError> {
        let ids: Vec<String> = self.with(|c| {
            let mut stmt = c.prepare(
                "SELECT DISTINCT m.id FROM meetings m JOIN files f ON f.meeting = m.id \
                 WHERE m.done_at IS NOT NULL AND m.done_at <= ?1 AND m.phase != 'live' \
                   AND f.kind IN ('audio', 'frame', 'video') \
                   AND f.state IN ('done', 'waiting', 'uploading') \
                 ORDER BY m.id",
            )?;
            let ids = stmt.query_map([to_i64(cutoff)], |r| r.get(0))?.collect();
            ids
        })?;
        let mut out = Vec::new();
        for id in ids {
            let rows = self.rows_where(
                "f.meeting = ?1 AND f.kind IN ('audio', 'frame', 'video') \
                 AND f.state IN ('done', 'waiting', 'uploading')",
                &id,
            )?;
            out.push((id, rows));
        }
        Ok(out)
    }

    /// Rows that won't go up but may still have an open multipart upload: (row, object, upload id).
    pub(crate) fn dangling_uploads(&self) -> Result<Vec<(i64, String, String)>, SyncError> {
        self.with(|c| {
            let mut stmt = c.prepare(
                "SELECT id, object, upload_id FROM files \
                 WHERE upload_id IS NOT NULL AND state IN ('gone', 'lost', 'removed')",
            )?;
            let rows = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect();
            rows
        })
    }

    pub(crate) fn clear_upload(&self, id: i64) -> Result<(), SyncError> {
        self.with(|c| {
            let tx = c.transaction()?;
            tx.execute("UPDATE files SET upload_id = NULL WHERE id = ?1", [id])?;
            tx.execute("DELETE FROM parts WHERE file = ?1", [id])?;
            tx.commit()
        })
    }

    /// Drops rows nobody needs any more: `gone` rows without an open upload, and old manifest and
    /// index versions that already went up.
    pub(crate) fn tidy(&self) -> Result<(), SyncError> {
        self.with(|c| {
            c.execute_batch(
                "DELETE FROM files WHERE state = 'gone' AND upload_id IS NULL; \
                 DELETE FROM files WHERE kind IN ('manifest', 'index') AND state = 'done' \
                   AND id < (SELECT MAX(id) FROM files g WHERE g.meeting = files.meeting \
                     AND g.kind = files.kind AND g.state = 'done');",
            )
        })
    }

    /// Staged files rows still need.
    pub(crate) fn staged(&self) -> Result<Vec<PathBuf>, SyncError> {
        self.with(|c| {
            let mut stmt = c.prepare(
                "SELECT source FROM files WHERE source IS NOT NULL \
                   AND state IN ('waiting', 'uploading')",
            )?;
            let rows = stmt
                .query_map([], |r| Ok(PathBuf::from(r.get::<_, String>(0)?)))?
                .collect();
            rows
        })
    }

    /// When the last file reached the bucket.
    pub(crate) fn last_upload(&self) -> Result<Option<u64>, SyncError> {
        self.with(|c| {
            c.query_row(
                "SELECT MAX(done_at) FROM files WHERE state IN ('done', 'removed') \
                   AND header IS NOT NULL",
                [],
                |r| Ok(r.get::<_, Option<i64>>(0)?.map(to_u64)),
            )
        })
    }

    /// A restored meeting's rows, all `done` without a header, and its `meetings` row with phase
    /// `restored` (2.11 step 1).
    pub(crate) fn import(&self, m: &Import<'_>) -> Result<(), SyncError> {
        self.with(|c| {
            let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute(
                "INSERT INTO meetings (id, mhash, phase, title, created_at, duration_ms, \
                   manifest_gen, media_removed_at, state, uploaded_gen) \
                 VALUES (?1, ?2, 'restored', ?3, ?4, ?5, ?6, ?7, ?8, ?6) \
                 ON CONFLICT (id) DO UPDATE SET mhash = excluded.mhash, phase = 'restored', \
                   title = excluded.title, created_at = excluded.created_at, \
                   duration_ms = excluded.duration_ms, \
                   manifest_gen = MAX(manifest_gen, excluded.manifest_gen), \
                   media_removed_at = excluded.media_removed_at, state = excluded.state, \
                   uploaded_gen = MAX(uploaded_gen, excluded.uploaded_gen)",
                params![
                    m.meeting,
                    m.mhash,
                    m.title,
                    to_i64(m.created_at),
                    m.duration_ms.map(to_i64),
                    to_i64(m.gen),
                    m.media_removed_at.map(to_i64),
                    m.state,
                ],
            )?;
            for f in m.files {
                tx.execute(
                    "INSERT OR IGNORE INTO files (meeting, path, kind, lane, size, sha256, object, \
                       track, seq, t, samples, state, created_at, done_at) \
                     VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'done', ?11, ?11)",
                    params![
                        m.meeting,
                        f.path,
                        f.kind,
                        to_i64(f.size),
                        f.sha256,
                        f.object,
                        f.track,
                        f.seq.map(to_i64),
                        f.t.map(to_i64),
                        f.samples.map(to_i64),
                        to_i64(m.now),
                    ],
                )?;
            }
            tx.commit()
        })
    }

    /// The newest finished row of a file: what a fetch reads back.
    pub(crate) fn in_bucket(&self, meeting: &str, path: &str) -> Result<Option<Row>, SyncError> {
        self.with(|c| {
            c.query_row(
                &format!(
                    "SELECT {ROW_COLUMNS} FROM files f WHERE f.meeting = ?1 AND f.path = ?2 \
                       AND f.state = 'done' ORDER BY f.id DESC LIMIT 1"
                ),
                params![meeting, path],
                row_from,
            )
            .optional()
        })
    }

    /// Forgets a meeting's rows. With `tombstone` its `meetings` row stays as `forgotten`, so the
    /// next index marks it deleted.
    pub(crate) fn drop_meeting(&self, meeting: &str, tombstone: bool) -> Result<(), SyncError> {
        self.with(|c| {
            let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute(
                "DELETE FROM parts WHERE file IN (SELECT id FROM files WHERE meeting = ?1)",
                [meeting],
            )?;
            tx.execute("DELETE FROM files WHERE meeting = ?1", [meeting])?;
            tx.execute("DELETE FROM restored WHERE meeting = ?1", [meeting])?;
            if tombstone {
                tx.execute(
                    "UPDATE meetings SET phase = 'forgotten', manifest_dirty = 0 WHERE id = ?1",
                    [meeting],
                )?;
            } else {
                tx.execute("DELETE FROM meetings WHERE id = ?1", [meeting])?;
            }
            tx.commit()
        })
    }
}

fn row_from(r: &rusqlite::Row<'_>) -> rusqlite::Result<Row> {
    let state: String = r.get(10)?;
    Ok(Row {
        id: r.get(0)?,
        meeting: r.get(1)?,
        path: r.get(2)?,
        kind: r.get(3)?,
        lane: u8::try_from(r.get::<_, i64>(4)?).unwrap_or(2),
        size: to_u64(r.get(5)?),
        sha256: r.get(6)?,
        object: r.get(7)?,
        header: r.get(8)?,
        source: r.get::<_, Option<String>>(9)?.map(PathBuf::from),
        state: RowState::parse(&state).unwrap_or(RowState::Gone),
        upload_id: r.get(11)?,
        part_size: r.get::<_, Option<i64>>(12)?.map(to_u64),
        attempts: u32::try_from(r.get::<_, i64>(13)?).unwrap_or(u32::MAX),
        next_at: to_u64(r.get(14)?),
    })
}

fn meeting_from(r: &rusqlite::Row<'_>) -> rusqlite::Result<MeetingRow> {
    Ok(MeetingRow {
        id: r.get(0)?,
        mhash: r.get(1)?,
        phase: r.get(2)?,
        title: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
        created_at: r.get::<_, Option<i64>>(4)?.map_or(0, to_u64),
        duration_ms: r.get::<_, Option<i64>>(5)?.map(to_u64),
        done_at: r.get::<_, Option<i64>>(6)?.map(to_u64),
        manifest_gen: to_u64(r.get(7)?),
        manifest_dirty: r.get::<_, i64>(8)? != 0,
        media_removed_at: r.get::<_, Option<i64>>(9)?.map(to_u64),
        state: r.get::<_, Option<String>>(10)?.unwrap_or_default(),
        uploaded_gen: to_u64(r.get(11)?),
        manifest_at: to_u64(r.get(12)?),
    })
}

pub(crate) fn to_i64(v: u64) -> i64 {
    i64::try_from(v).unwrap_or(i64::MAX)
}

pub(crate) fn to_u64(v: i64) -> u64 {
    u64::try_from(v).unwrap_or(0)
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn db(e: rusqlite::Error) -> SyncError {
    SyncError::new(SyncErrorKind::Local, format!("The sync queue failed: {e}"))
}

fn local(what: &str, e: &std::io::Error) -> SyncError {
    SyncError::new(SyncErrorKind::Local, format!("{what}: {e}"))
}

/// `bytes` random bytes as lowercase hex.
pub(crate) fn random_hex(bytes: usize) -> Result<String, SyncError> {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).map_err(|e| {
        SyncError::new(
            SyncErrorKind::Local,
            format!("Voice can't get random bytes: {e}"),
        )
    })?;
    Ok(hex(&buf))
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(DIGITS[usize::from(b >> 4)] as char);
        s.push(DIGITS[usize::from(b & 15)] as char);
    }
    s
}
