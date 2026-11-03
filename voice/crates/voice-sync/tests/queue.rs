//! The upload queue, `<data>/sync/queue.db` (spec 2.7, 2.10).

mod harness;

use std::path::Path;
use std::time::Duration;

use harness::*;
use rusqlite::Connection;
use voice_sync::queue::{NewRow, Queue, RowState, QUEUE_FILE, RESTORED_HOLD_MS, SCHEMA_VERSION};
use voice_sync::s3::Part;
use voice_sync::{BucketSync, SyncErrorKind, SyncOptions, SYNC_DIR};

const KID: &str = "0f1e2d3c4b5a6978";

fn row(meeting: &str, path: &str, kind: &str, lane: u8, sha: &str) -> NewRow {
    NewRow {
        meeting: meeting.into(),
        path: path.into(),
        kind: kind.into(),
        lane,
        size: 100,
        mtime: Some(1),
        sha256: sha.into(),
        object: format!("rkv1/{KID}/m/{meeting}/o/{path}-{sha}"),
        header: vec![7; 115],
        source: None,
        track: None,
        seq: None,
        t: None,
        samples: None,
        created_at: 10,
    }
}

fn db(sync_dir: &Path) -> Connection {
    Connection::open(sync_dir.join(QUEUE_FILE)).unwrap()
}

fn set_phase(sync_dir: &Path, meeting: &str, phase: &str) {
    db(sync_dir)
        .execute(
            "UPDATE meetings SET phase = ?2 WHERE id = ?1",
            [meeting, phase],
        )
        .unwrap();
}

/// Takes rows in order, marking each done, and returns their paths.
fn drain(q: &Queue, live_only: bool) -> Vec<String> {
    let mut out = Vec::new();
    while let Some(r) = q.next(u64::MAX / 2, live_only).unwrap() {
        out.push(r.path.clone());
        q.done(r.id, 5).unwrap();
    }
    out
}

#[test]
fn the_schema_has_its_version_and_a_writer() {
    let dir = scratch("queue-schema");
    let _c = Cleanup(dir.clone());
    let q = Queue::open(&dir).unwrap();
    let writer = q.writer();
    assert_eq!(writer.len(), 32);
    assert!(writer.bytes().all(|b| b.is_ascii_hexdigit()));
    drop(q);
    let conn = db(&dir);
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, SCHEMA_VERSION);
    let mode: String = conn
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .unwrap();
    assert_eq!(mode.to_lowercase(), "wal");
    for table in ["meta", "meetings", "files", "parts", "restored", "errors"] {
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1, "{table}");
    }
    drop(conn);
    // The writer id stays with the data folder.
    assert_eq!(Queue::open(&dir).unwrap().writer(), writer);
}

#[test]
fn a_queue_from_a_newer_voice_is_refused() {
    let data = scratch("queue-newer");
    let _c = Cleanup(data.clone());
    let sync_dir = data.join(SYNC_DIR);
    drop(Queue::open(&sync_dir).unwrap());
    db(&sync_dir)
        .pragma_update(None, "user_version", SCHEMA_VERSION + 1)
        .unwrap();
    let err = Queue::open(&sync_dir).err().expect("refused");
    assert_eq!(err.kind, SyncErrorKind::Local);
    assert!(err.message.contains("newer Voice"), "{}", err.message);
    // BucketSync::open fails the same way, so the engine runs without sync.
    let opened = voice_sync::BucketSync::open(voice_sync::SyncOptions {
        data_dir: data.clone(),
        meetings_dir: data.join("meetings"),
        protector: std::sync::Arc::new(voice_sync::protect::TestProtector),
        screen: std::sync::Arc::new(voice_sync::NoScreen),
        now: std::sync::Arc::new(now_ms),
        reserve: std::sync::Arc::new(|_| true),
        timing: timing(),
        on_change: std::sync::Arc::new(|| {}),
    });
    assert_eq!(opened.err().map(|e| e.kind), Some(SyncErrorKind::Local));
}

#[test]
fn one_row_per_version_of_a_file() {
    let dir = scratch("queue-unique");
    let _c = Cleanup(dir.clone());
    let q = Queue::open(&dir).unwrap();
    q.ensure_meeting("m-1", "h1", "Weekly", 1).unwrap();
    assert!(q
        .insert(row("m-1", "timeline.jsonl", "timeline", 1, "aa"))
        .unwrap());
    assert!(!q
        .insert(row("m-1", "timeline.jsonl", "timeline", 1, "aa"))
        .unwrap());
    assert!(q
        .insert(row("m-1", "timeline.jsonl", "timeline", 1, "bb"))
        .unwrap());
    assert!(q
        .insert(row("m-2", "timeline.jsonl", "timeline", 1, "aa"))
        .unwrap());
    let (size, mtime, sha) = q.known("m-1", "timeline.jsonl").unwrap().unwrap();
    assert_eq!((size, mtime, sha.as_str()), (100, Some(1), "bb"));
    assert_eq!(q.known("m-1", "meeting.json").unwrap(), None);
    // A version that went `gone` doesn't count as known.
    let bb: i64 = db(&dir)
        .query_row("SELECT id FROM files WHERE sha256 = 'bb'", [], |r| r.get(0))
        .unwrap();
    q.gone(bb).unwrap();
    let (_, _, sha) = q.known("m-1", "timeline.jsonl").unwrap().unwrap();
    assert_eq!(sha, "aa");
    // The same bytes again bring the gone version back instead of a duplicate.
    assert!(q
        .insert(row("m-1", "timeline.jsonl", "timeline", 1, "bb"))
        .unwrap());
    let n: i64 = db(&dir)
        .query_row(
            "SELECT COUNT(*) FROM files WHERE sha256 = 'bb' AND state = 'waiting'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 1);
}

#[test]
fn rows_go_by_lane_and_a_live_meeting_takes_only_its_lane() {
    let dir = scratch("queue-order");
    let _c = Cleanup(dir.clone());
    let q = Queue::open(&dir).unwrap();
    for (id, _) in [("m-20260101-000000-0001", 0), ("m-20260102-000000-0001", 0)] {
        q.ensure_meeting(id, "h", "", 0).unwrap();
    }
    q.ensure_meeting("m-live", "h", "", 0).unwrap();
    q.ensure_meeting("m-after", "h", "", 0).unwrap();
    let old = "m-20260101-000000-0001";
    let new = "m-20260102-000000-0001";
    q.insert(row(old, "audio/mic/000001.wav", "audio", 2, "1"))
        .unwrap();
    q.insert(row(new, "timeline.jsonl", "timeline", 2, "2"))
        .unwrap();
    q.insert(row(new, "audio/mic/000001.wav", "audio", 2, "3"))
        .unwrap();
    q.insert(row("m-after", "timeline.jsonl", "timeline", 1, "4"))
        .unwrap();
    q.insert(row("m-after", "audio/mic/000009.wav", "audio", 0, "5"))
        .unwrap();
    q.insert(row(
        "m-live",
        "screen/frames/f-000001000.jpg",
        "frame",
        0,
        "6",
    ))
    .unwrap();
    q.insert(row("m-live", "audio/call/000001.wav", "audio", 0, "7"))
        .unwrap();
    q.insert(row("m-live", "meeting.json", "meeting", 0, "8"))
        .unwrap();
    q.insert(row("m-live", "manifest", "manifest", 0, "9"))
        .unwrap();
    set_phase(&dir, "m-live", "live");

    // While a meeting is live only its lane-0 rows go: meeting.json, audio before frames, the
    // manifest last.
    assert_eq!(
        drain(&q, true),
        [
            "meeting.json",
            "audio/call/000001.wav",
            "screen/frames/f-000001000.jpg",
            "manifest"
        ]
    );
    // Then lane 0, lane 1, and lane 2 newest meeting first.
    assert_eq!(
        drain(&q, false),
        [
            "audio/mic/000009.wav",
            "timeline.jsonl",
            "audio/mic/000001.wav",
            "timeline.jsonl",
            "audio/mic/000001.wav"
        ]
    );
}

#[test]
fn a_row_waits_for_its_retry() {
    let dir = scratch("queue-retry");
    let _c = Cleanup(dir.clone());
    let q = Queue::open(&dir).unwrap();
    q.ensure_meeting("m-1", "h", "", 0).unwrap();
    q.insert(row("m-1", "meeting.json", "meeting", 1, "a"))
        .unwrap();
    let r = q.next(100, false).unwrap().unwrap();
    assert_eq!((r.attempts, r.next_at), (0, 0));
    let err = voice_sync::SyncError::new(SyncErrorKind::Network, "down");
    q.retry(r.id, 5_000, &err).unwrap();
    assert!(q.next(4_999, false).unwrap().is_none());
    let again = q.next(5_000, false).unwrap().unwrap();
    assert_eq!((again.attempts, again.next_at), (1, 5_000));
}

#[test]
fn retries_a_clock_that_ran_ahead_set_become_due() {
    let dir = scratch("queue-ahead");
    let _c = Cleanup(dir.clone());
    let q = Queue::open(&dir).unwrap();
    q.ensure_meeting("m-1", "h", "", 0).unwrap();
    q.insert(row("m-1", "meeting.json", "meeting", 1, "a"))
        .unwrap();
    q.insert(row("m-1", "timeline.jsonl", "timeline", 1, "b"))
        .unwrap();
    let err = voice_sync::SyncError::new(SyncErrorKind::Network, "down");
    let now = 1_800_000_000_000;
    const DAY: u64 = 86_400_000;
    // Scheduled while the clock ran two days ahead, and an ordinary retry a minute from now.
    let ahead = q.next(now, false).unwrap().unwrap();
    q.retry(ahead.id, now + 2 * DAY, &err).unwrap();
    let soon = q.next(now, false).unwrap().unwrap();
    q.retry(soon.id, now + 60_000, &err).unwrap();
    assert!(q.next(now, false).unwrap().is_none());
    assert_eq!(q.reschedule_ahead(now, 10 * 60_000).unwrap(), 1);
    let due = q.next(now, false).unwrap().expect("due now");
    assert_eq!((due.id, due.next_at), (ahead.id, now));
    q.done(due.id, now).unwrap();
    assert!(
        q.next(now, false).unwrap().is_none(),
        "the near retry keeps its time"
    );
}

#[test]
fn multipart_state_survives_in_the_queue() {
    let dir = scratch("queue-parts");
    let _c = Cleanup(dir.clone());
    let q = Queue::open(&dir).unwrap();
    q.ensure_meeting("m-1", "h", "", 0).unwrap();
    q.insert(row("m-1", "screen/video/000001.mp4", "video", 1, "v"))
        .unwrap();
    let r = q.next(1, false).unwrap().unwrap();
    q.set_upload(r.id, Some("up-1"), Some(8 << 20)).unwrap();
    q.part_done(r.id, 2, "\"e2\"", 8 << 20).unwrap();
    q.part_done(r.id, 1, "\"e1\"", 8 << 20).unwrap();
    drop(q);
    let q = Queue::open(&dir).unwrap();
    let r = q.next(1, false).unwrap().unwrap();
    assert_eq!(r.state, RowState::Uploading);
    assert_eq!(r.upload_id.as_deref(), Some("up-1"));
    assert_eq!(r.part_size, Some(8 << 20));
    let numbers: Vec<u16> = q.parts(r.id).unwrap().iter().map(|p| p.number).collect();
    assert_eq!(numbers, [1, 2]);
    q.replace_parts(
        r.id,
        &[Part {
            number: 3,
            etag: "\"e3\"".into(),
            size: 5,
        }],
    )
    .unwrap();
    assert_eq!(q.parts(r.id).unwrap().len(), 1);
    // Forgetting the upload forgets its parts.
    q.set_upload(r.id, None, None).unwrap();
    assert!(q.parts(r.id).unwrap().is_empty());
    let r = q.next(1, false).unwrap().unwrap();
    assert_eq!((r.state, r.upload_id), (RowState::Waiting, None));
}

#[test]
fn holds_media_follows_the_rules_of_retention() {
    let dir = scratch("queue-holds");
    let _c = Cleanup(dir.clone());
    let q = Queue::open(&dir).unwrap();
    let now = 100 * RESTORED_HOLD_MS;
    q.ensure_meeting("m-1", "h", "", 0).unwrap();
    q.insert(row("m-1", "audio/mic/000001.wav", "audio", 0, "a"))
        .unwrap();
    set_phase(&dir, "m-1", "synced");

    // A waiting audio row holds the media while sync is on, not while it is off.
    assert!(q.holds_media("m-1", true, true, now).unwrap());
    assert!(!q.holds_media("m-1", false, true, now).unwrap());
    let r = q.next(now, false).unwrap().unwrap();
    q.done(r.id, now).unwrap();
    set_phase(&dir, "m-1", "synced");
    assert!(!q.holds_media("m-1", true, true, now).unwrap());

    // Frames and video hold too.
    q.insert(row("m-1", "screen/video/000001.mp4", "video", 1, "v"))
        .unwrap();
    assert!(q.holds_media("m-1", true, true, now).unwrap());
    let r = q.next(now, false).unwrap().unwrap();
    q.set_upload(r.id, Some("u"), Some(8)).unwrap();
    assert!(
        q.holds_media("m-1", true, true, now).unwrap(),
        "uploading holds"
    );
    q.done(r.id, now).unwrap();
    q.insert(row("m-1", "screen/frames/f-000000001.jpg", "frame", 0, "f"))
        .unwrap();
    assert!(q.holds_media("m-1", true, true, now).unwrap());
    let r = q.next(now, false).unwrap().unwrap();
    q.done(r.id, now).unwrap();
    set_phase(&dir, "m-1", "synced");
    assert!(!q.holds_media("m-1", true, true, now).unwrap());

    // A transcript waiting doesn't hold media.
    q.insert(row("m-1", "transcript.db", "transcript", 1, "t"))
        .unwrap();
    assert!(!q.holds_media("m-1", true, true, now).unwrap());

    // Media on disk of a meeting the scan hasn't reached yet, or one that records or still
    // uploads, is held while sync is on.
    assert!(q.holds_media("m-new", true, true, now).unwrap());
    assert!(!q.holds_media("m-new", true, false, now).unwrap());
    assert!(!q.holds_media("m-new", false, true, now).unwrap());
    for phase in ["live", "after"] {
        set_phase(&dir, "m-1", phase);
        assert!(q.holds_media("m-1", true, true, now).unwrap(), "{phase}");
    }
    set_phase(&dir, "m-1", "synced");

    // Media a restore brought back stays 24 hours after its last use, with sync off too.
    q.restored(
        "m-2",
        "audio/mic/000001.wav",
        now - RESTORED_HOLD_MS + 1_000,
    )
    .unwrap();
    assert!(q.holds_media("m-2", false, true, now).unwrap());
    assert!(!q.holds_media("m-2", false, true, now + 1_000).unwrap());
    q.restored("m-2", "audio/mic/000001.wav", now).unwrap();
    assert!(q.holds_media("m-2", false, false, now + 1_000).unwrap());
}

#[test]
fn has_waiting_lost_and_waiting_counts() {
    let dir = scratch("queue-lost");
    let _c = Cleanup(dir.clone());
    let q = Queue::open(&dir).unwrap();
    assert!(
        q.has_waiting("m-1").unwrap(),
        "never scanned: nothing reached the bucket"
    );
    q.ensure_meeting("m-1", "h", "", 0).unwrap();
    assert!(!q.has_waiting("m-1").unwrap());
    q.insert(row("m-1", "audio/mic/000001.wav", "audio", 0, "a1"))
        .unwrap();
    q.insert(row("m-1", "audio/mic/000002.wav", "audio", 0, "a2"))
        .unwrap();
    q.insert(row("m-1", "screen/frames/f-000000001.jpg", "frame", 0, "f"))
        .unwrap();
    q.insert(row("m-1", "screen/video/000001.mp4", "video", 1, "v"))
        .unwrap();
    q.insert(row("m-1", "manifest", "manifest", 1, "m"))
        .unwrap();
    assert!(q.has_waiting("m-1").unwrap());
    let (files, bytes, oldest) = q.waiting().unwrap();
    assert_eq!(
        (files, bytes, oldest),
        (4, 400, Some(10)),
        "manifests don't count"
    );

    let first = q.next(1, false).unwrap().unwrap();
    assert_eq!(first.path, "audio/mic/000001.wav");
    q.done(first.id, 1).unwrap();
    assert_eq!(q.mark_lost("m-1", &["video"]).unwrap(), 1);
    assert_eq!(q.lost().unwrap(), 1);
    assert_eq!(
        q.mark_lost("m-1", &["frame", "audio"]).unwrap(),
        2,
        "the done one stays"
    );
    assert_eq!(q.lost().unwrap(), 3);
    assert_eq!(q.mark_lost("m-1", &["audio"]).unwrap(), 0);
    assert_eq!(q.waiting().unwrap().0, 0);
}

#[test]
fn uploaded_with_knows_what_this_computer_sent() {
    let dir = scratch("queue-uploaded");
    let _c = Cleanup(dir.clone());
    let q = Queue::open(&dir).unwrap();
    q.ensure_meeting("m-1", "h", "", 0).unwrap();
    q.insert(row("m-1", "meeting.json", "meeting", 1, "a"))
        .unwrap();
    q.insert(row("m-1", "screen/video/000001.mp4", "video", 1, "b"))
        .unwrap();
    assert!(!q.uploaded_with(KID).unwrap());
    let r = q.next(1, false).unwrap().unwrap();
    assert_eq!(r.path, "meeting.json");
    q.done(r.id, 1).unwrap();
    assert!(q.uploaded_with(KID).unwrap());
    assert!(!q.uploaded_with("1111111111111111").unwrap());

    // A part of an unfinished multipart upload counts too.
    let dir2 = scratch("queue-uploaded-part");
    let _c2 = Cleanup(dir2.clone());
    let q = Queue::open(&dir2).unwrap();
    q.ensure_meeting("m-1", "h", "", 0).unwrap();
    q.insert(row("m-1", "screen/video/000001.mp4", "video", 1, "b"))
        .unwrap();
    let r = q.next(1, false).unwrap().unwrap();
    q.set_upload(r.id, Some("u"), Some(8)).unwrap();
    assert!(!q.uploaded_with(KID).unwrap());
    q.part_done(r.id, 1, "\"e\"", 8).unwrap();
    assert!(q.uploaded_with(KID).unwrap());
}

#[test]
fn note_error_keeps_the_newest_twenty() {
    let dir = scratch("queue-errors");
    let _c = Cleanup(dir.clone());
    let q = Queue::open(&dir).unwrap();
    for i in 0..30 {
        q.note_error(
            i,
            &voice_sync::SyncError::new(SyncErrorKind::Network, format!("e{i}")),
        )
        .unwrap();
    }
    let conn = db(&dir);
    let (n, min): (i64, i64) = conn
        .query_row("SELECT COUNT(*), MIN(at) FROM errors", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!((n, min), (20, 10));
    let code: String = conn
        .query_row("SELECT code FROM errors LIMIT 1", [], |r| r.get(0))
        .unwrap();
    assert_eq!(code, "network");
}

#[test]
fn a_broken_queue_holds_every_meeting_with_media() {
    let fake = fake();
    let data = scratch("queue-broken");
    let _c = Cleanup(data.clone());
    let voice = Voice::open(&data);
    let m = Meeting::new(&voice.meetings(), "Broken", 60_000);
    m.segment("mic", 1, 0, 16_000);
    m.stop(1_000);
    m.transcript(&[("mic", 0, 900, "hello")], now_ms());
    voice.connect(&fake.endpoint());
    voice.settle(&fake, Duration::from_secs(30));
    assert!(
        !voice.sync.holds_media(&m.id, true),
        "everything is in the bucket"
    );
    assert!(!voice.sync.has_waiting(&m.id));

    // Another connection breaks the queue under the worker.
    db(&data.join(SYNC_DIR))
        .execute_batch("DROP TABLE files; DROP TABLE meetings; DROP TABLE restored;")
        .unwrap();
    assert!(voice.sync.holds_media(&m.id, true));
    assert!(voice.sync.has_waiting(&m.id));
    voice.sync.configure(None);
    assert!(
        voice.sync.holds_media(&m.id, false),
        "a broken queue holds with sync off too"
    );
    assert_eq!(voice.sync.mark_lost(&m.id, &["audio"]), 0);
}

#[test]
fn configuring_without_a_change_tells_settings_nothing() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let fake = fake();
    let data = scratch("queue-quiet");
    let _c = Cleanup(data.clone());
    std::fs::create_dir_all(data.join("meetings")).unwrap();
    let calls = std::sync::Arc::new(AtomicUsize::new(0));
    let counted = calls.clone();
    let sync = BucketSync::open(SyncOptions {
        data_dir: data.clone(),
        meetings_dir: data.join("meetings"),
        protector: std::sync::Arc::new(voice_sync::protect::TestProtector),
        screen: std::sync::Arc::new(voice_sync::NoScreen),
        now: std::sync::Arc::new(now_ms),
        reserve: std::sync::Arc::new(|_| true),
        timing: timing(),
        on_change: std::sync::Arc::new(move || {
            counted.fetch_add(1, Ordering::SeqCst);
        }),
    })
    .unwrap();
    // The engine's start with sync off: the state Settings already show, nothing to send.
    sync.configure(None);
    sync.configure(None);
    std::thread::sleep(Duration::from_millis(700));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    // Turning it on is news.
    sync.save_secret(SECRET).unwrap();
    let before = calls.load(Ordering::SeqCst);
    sync.configure(Some(config(&fake.endpoint())));
    assert!(wait_for(Duration::from_secs(2), || calls
        .load(Ordering::SeqCst)
        > before));
    sync.shutdown();
}
