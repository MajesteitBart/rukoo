//! What a `transcript.db` says, as one hash: every table but `emitted`, row by row.
//!
//! Two copies of one transcript differ as files once a computer follows the meeting: the pipeline
//! notes in `emitted` which events its own event log holds, under that log's sequence numbers, and
//! SQLite lays out pages as the writes came. Comparing files would make a computer that pulled a
//! meeting upload it again, and the computer it came from pull it back, without end. The digest
//! changes only when the meeting's text, speakers, marks or labelling state do.

use std::fmt::Write as _;
use std::path::Path;

use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};
use sha2::{Digest, Sha256};

use crate::{SyncError, SyncErrorKind};

/// Tables that only say what this computer's event log holds.
const LOCAL_TABLES: [&str; 1] = ["emitted"];

/// The digest of the transcript database at `path`, which may be in WAL mode.
pub fn transcript_digest(path: &Path) -> Result<String, SyncError> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| unreadable(&e))?;
    digest_of(&conn).map_err(|e| unreadable(&e))
}

fn digest_of(conn: &Connection) -> rusqlite::Result<String> {
    let tables: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' \
             ORDER BY name",
        )?;
        let names = stmt
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        names
    };
    let mut hash = Sha256::new();
    for table in tables {
        if LOCAL_TABLES.contains(&table.as_str()) {
            continue;
        }
        let quoted = format!("\"{}\"", table.replace('"', "\"\""));
        let columns = {
            let stmt = conn.prepare(&format!("SELECT * FROM {quoted} LIMIT 0"))?;
            stmt.column_count()
        };
        hash.update(b"table\0");
        hash.update(table.as_bytes());
        hash.update(b"\0");
        if columns == 0 {
            continue;
        }
        let order = (1..=columns)
            .map(|i| i.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        let mut stmt = conn.prepare(&format!("SELECT * FROM {quoted} ORDER BY {order}"))?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            hash.update(b"row");
            for i in 0..columns {
                match row.get_ref(i)? {
                    ValueRef::Null => hash.update(b"n"),
                    ValueRef::Integer(n) => {
                        hash.update(b"i");
                        hash.update(n.to_be_bytes());
                    }
                    ValueRef::Real(f) => {
                        hash.update(b"r");
                        hash.update(f.to_bits().to_be_bytes());
                    }
                    ValueRef::Text(t) => {
                        hash.update(b"t");
                        hash.update((t.len() as u64).to_be_bytes());
                        hash.update(t);
                    }
                    ValueRef::Blob(b) => {
                        hash.update(b"b");
                        hash.update((b.len() as u64).to_be_bytes());
                        hash.update(b);
                    }
                }
            }
        }
    }
    let mut out = String::with_capacity(64);
    for byte in hash.finalize() {
        let _ = write!(out, "{byte:02x}");
    }
    Ok(out)
}

fn unreadable(e: &rusqlite::Error) -> SyncError {
    SyncError::new(
        SyncErrorKind::Local,
        format!("Voice can't read a transcript: {e}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "voice-sync-digest-{name}-{}-{}",
            std::process::id(),
            crate::queue::random_hex(4).unwrap()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn db(path: &Path, rows: &[(&str, &str)], emitted: &[(&str, i64)]) {
        let c = Connection::open(path).unwrap();
        c.execute_batch(
            "PRAGMA journal_mode = WAL; \
             CREATE TABLE passages (id TEXT PRIMARY KEY, text TEXT NOT NULL); \
             CREATE TABLE emitted (key TEXT PRIMARY KEY, seq INTEGER NOT NULL);",
        )
        .unwrap();
        for (id, text) in rows {
            c.execute("INSERT INTO passages VALUES (?1, ?2)", [id, text])
                .unwrap();
        }
        for (key, seq) in emitted {
            c.execute(
                "INSERT INTO emitted VALUES (?1, ?2)",
                rusqlite::params![key, seq],
            )
            .unwrap();
        }
    }

    #[test]
    fn the_event_log_notes_and_the_write_order_dont_count() {
        let dir = scratch("same");
        let (a, b) = (dir.join("a.db"), dir.join("b.db"));
        db(
            &a,
            &[("p1", "Hello"), ("p2", "Thursday")],
            &[("passage:p1:1", 4)],
        );
        db(
            &b,
            &[("p2", "Thursday"), ("p1", "Hello")],
            &[("passage:p1:1", 911), ("x", 2)],
        );
        assert_eq!(
            transcript_digest(&a).unwrap(),
            transcript_digest(&b).unwrap()
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_changed_passage_changes_it() {
        let dir = scratch("changed");
        let (a, b) = (dir.join("a.db"), dir.join("b.db"));
        db(&a, &[("p1", "Hello")], &[]);
        db(&b, &[("p1", "Hello.")], &[]);
        assert_ne!(
            transcript_digest(&a).unwrap(),
            transcript_digest(&b).unwrap()
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_missing_file_is_an_error() {
        let dir = scratch("missing");
        assert!(transcript_digest(&dir.join("none.db")).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
