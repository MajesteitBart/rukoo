//! Restore and fetching back (spec 2.11; acceptance criterion 7).

mod harness;

use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use harness::*;
use voice_recorder::timeline::{self, History};
use voice_sync::manifest::{Manifest, ManifestFile};
use voice_sync::restore::{synthesize_timeline, BAD_MANIFEST};
use voice_sync::s3::Bucket;
use voice_sync::{recovery, SyncErrorKind};

const WAIT: Duration = Duration::from_secs(30);

/// A finished meeting with two segments per track and a transcript.
fn finished(meetings: &std::path::Path, title: &str, ago: u64) -> (Meeting, Vec<String>) {
    let m = Meeting::new(meetings, title, ago);
    let segments = vec![
        m.segment("mic", 1, 0, 16_000),
        m.segment("call", 1, 3, 16_000),
        m.segment("mic", 2, 1_000, 8_000),
        m.segment("call", 2, 1_003, 8_000),
    ];
    m.stop(1_503);
    m.transcript(
        &[
            ("mic", 0, 900, "First thing"),
            ("call", 900, 1_400, "Second thing"),
        ],
        now_ms() - ago / 2,
    );
    (m, segments)
}

fn wait_restore(voice: &Voice, state: &str) -> voice_sync::RestoreState {
    let ok = wait_for(WAIT, || voice.sync.status().restore.state == state);
    let restore = voice.sync.status().restore;
    assert!(ok, "restore ended as {restore:?}, not {state}");
    restore
}

/// No `.restore-*` folder is left in the library.
fn no_partial_folders(voice: &Voice) {
    let left: Vec<_> = fs::read_dir(voice.meetings())
        .unwrap()
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with(".restore-"))
        .collect();
    assert!(left.is_empty(), "{left:?}");
}

#[test]
fn a_fresh_data_folder_with_the_saved_key_restores_a_meeting() {
    let fake = fake();
    let root = scratch("restore-fresh");
    let _c = Cleanup(root.clone());
    let a = Voice::open(&root.join("a"));
    let (m, segments) = finished(&a.meetings(), "Weekly with Anna", 3_600_000);
    a.connect(&fake.endpoint());
    a.settle(&fake, WAIT);
    let (code, id) = a.sync.show_key().unwrap();
    assert!(code.starts_with("RKV1-"));
    assert_eq!(id.len(), 8);
    a.sync.mark_key_saved().unwrap();
    assert!(a.sync.status().key.exported);

    let b = Voice::open(&root.join("b"));
    assert_eq!(b.sync.import_key(&code).unwrap(), id);
    b.connect(&fake.endpoint());
    let listed = b.sync.remote_meetings().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, m.id);
    assert_eq!(listed[0].title, "Weekly with Anna");
    assert_eq!(listed[0].started_at, m.created_at);
    assert_eq!(listed[0].duration_ms, Some(1_503));
    assert_eq!(b.sync.status().restore.available, 1);

    let (seen, on_restored) = recorder();
    b.sync.restore(Vec::new(), on_restored).unwrap();
    let restore = wait_restore(&b, "done");
    assert_eq!((restore.done, restore.total), (1, 1));
    assert_eq!(*seen.lock().unwrap(), vec![m.id.clone()]);
    let dir = b.meetings().join(&m.id);
    assert_eq!(
        fs::read(dir.join("meeting.json")).unwrap(),
        m.read("meeting.json")
    );
    assert_eq!(
        fs::read(dir.join("timeline.jsonl")).unwrap(),
        m.read("timeline.jsonl")
    );
    assert_eq!(Meeting::passages(&dir), Meeting::passages(&m.dir));
    // The meeting is done, so its audio stays in the bucket until something needs it.
    assert!(!dir.join("audio").exists());
    no_partial_folders(&b);
    assert!(
        b.sync.remote_meetings().unwrap().is_empty(),
        "it is here now"
    );

    for s in &segments {
        assert!(b.sync.in_bucket(&m.id, s));
    }
    b.sync
        .ensure_local(&m.id, &segments, &AtomicBool::new(false))
        .unwrap();
    for s in &segments {
        assert_eq!(fs::read(dir.join(s)).unwrap(), m.read(s), "{s}");
    }
    // Fetched media stays at least a day, with sync off too.
    assert!(b.sync.holds_media(&m.id));
    b.sync.configure(None);
    assert!(b.sync.holds_media(&m.id));
}

#[test]
fn another_key_sees_nothing_and_counts_as_other() {
    let fake = fake();
    let root = scratch("restore-other-key");
    let _c = Cleanup(root.clone());
    let a = Voice::open(&root.join("a"));
    finished(&a.meetings(), "Theirs", 3_600_000);
    a.connect(&fake.endpoint());
    a.settle(&fake, WAIT);

    let b = Voice::open(&root.join("b"));
    let (_, b_id) = b.sync.show_key().unwrap();
    assert_ne!(Some(b_id), a.sync.status().key.id);
    b.sync.save_secret(SECRET).unwrap();
    let report = b.sync.test(&config(&fake.endpoint())).unwrap();
    assert_eq!(report.other_keys, 1);
    assert_eq!(b.sync.status().other_keys, 1);
    b.sync.configure(Some(config(&fake.endpoint())));
    assert!(b.sync.remote_meetings().unwrap().is_empty());
}

#[test]
fn a_meeting_lost_mid_recording_gets_a_timeline() {
    // The function alone: entries out of order, a missing track and seq read from the path.
    let entry = |path: &str, t: u64, samples: u64| ManifestFile {
        path: path.into(),
        kind: "audio".into(),
        object: "o".into(),
        size: 44 + samples * 2,
        sha256: "s".into(),
        track: None,
        seq: None,
        t: Some(t),
        samples: Some(samples),
    };
    let text = synthesize_timeline(
        1_793_000_000_000,
        &[
            entry("audio/mic/000002.wav", 30_000, 480_000),
            entry("audio/call/000001.wav", 5, 160_000),
            entry("audio/mic/000001.wav", 0, 480_000),
        ],
    );
    let lines = timeline::parse(&text);
    let history = History::from_lines(&lines);
    assert_eq!(history.first_wall, Some(1_793_000_000_000));
    assert!(history.stopped);
    let placed: Vec<(String, u64, u64, Option<u64>)> = history
        .segments
        .iter()
        .map(|s| (s.track.clone(), s.seq, s.t, s.ended))
        .collect();
    assert_eq!(
        placed,
        [
            ("mic".into(), 1, 0, Some(480_000)),
            ("call".into(), 1, 5, Some(160_000)),
            ("mic".into(), 2, 30_000, Some(480_000)),
        ]
    );
    assert_eq!(history.latest_t, 60_000);
    assert!(text.contains("\"reason\":\"interrupted\""));
    assert!(text.contains("\"recorder\":\"restored\""));

    // Through a restore: the computer was lost while it recorded, so only meeting.json, closed
    // segments and a live manifest reached the bucket.
    let fake = fake();
    let root = scratch("restore-lost");
    let _c = Cleanup(root.clone());
    let a = Voice::open(&root.join("a"));
    let m = Meeting::new(&a.meetings(), "Cut off", 0);
    let s1 = m.segment("mic", 1, 0, 16_000);
    let s2 = m.segment("call", 1, 7, 16_000);
    a.connect(&fake.endpoint());
    assert!(wait_for(WAIT, || a.sync.status().key.exists));
    let key = a.key();
    let ok = wait_for(WAIT, || {
        manifest(&fake, &key, &m.id).is_some_and(|mf| mf.files.len() == 3)
    });
    assert!(ok, "a live manifest with meeting.json and two segments");
    let (code, _) = a.sync.show_key().unwrap();
    drop(a);

    let b = Voice::open(&root.join("b"));
    b.sync.import_key(&code).unwrap();
    b.connect(&fake.endpoint());
    let (_, on_restored) = recorder();
    b.sync.restore(vec![m.id.clone()], on_restored).unwrap();
    wait_restore(&b, "done");
    let dir = b.meetings().join(&m.id);
    let history = History::from_lines(&timeline::read(&dir.join("timeline.jsonl")).unwrap());
    assert!(history.stopped);
    let placed: Vec<(String, u64)> = history
        .segments
        .iter()
        .map(|s| (s.file.clone(), s.t))
        .collect();
    assert_eq!(placed, [(s1.clone(), 0), (s2.clone(), 7)]);
    // The meeting never finished, so its audio came back for transcription.
    assert_eq!(fs::read(dir.join(&s1)).unwrap(), m.read(&s1));
    assert_eq!(fs::read(dir.join(&s2)).unwrap(), m.read(&s2));
}

#[test]
fn ensure_local_refuses_without_sync_and_without_a_row() {
    let fake = fake();
    let data = scratch("restore-ensure");
    let _c = Cleanup(data.clone());
    let a = Voice::open(&data);
    let (m, segments) = finished(&a.meetings(), "Fetch", 3_600_000);
    a.connect(&fake.endpoint());
    a.settle(&fake, WAIT);
    let original = m.read(&segments[0]);
    fs::remove_dir_all(m.path("audio")).unwrap();
    let never = AtomicBool::new(false);

    a.sync.configure(None);
    let err = a
        .sync
        .ensure_local(&m.id, &segments[..1], &never)
        .unwrap_err();
    assert_eq!(err.kind, SyncErrorKind::Off);
    assert!(!a.sync.can_fetch());

    a.sync.configure(Some(config(&fake.endpoint())));
    assert!(a.sync.can_fetch());
    let err = a
        .sync
        .ensure_local(&m.id, &["audio/mic/000009.wav".to_owned()], &never)
        .unwrap_err();
    assert_eq!(err.kind, SyncErrorKind::NotInBucket);
    assert!(!m.path("audio/mic/000009.wav").exists());
    let err = a
        .sync
        .ensure_local(&m.id, &["../meeting.json".to_owned()], &never)
        .unwrap_err();
    assert_eq!(err.kind, SyncErrorKind::NotInBucket);

    a.sync.ensure_local(&m.id, &segments[..1], &never).unwrap();
    assert_eq!(m.read(&segments[0]), original);
    assert!(!m.path(&format!("{}.restore", segments[0])).exists());
    // A file that is there with its size isn't fetched again.
    let object = file_object(&a.key(), &m.id, &segments[0], &original);
    let gets = || {
        fake.log()
            .iter()
            .filter(|l| l.op == voice_s3_fake::Op::Get && unprefixed(&l.key) == object)
            .count()
    };
    let before = gets();
    assert!(before >= 1);
    a.sync.ensure_local(&m.id, &segments[..1], &never).unwrap();
    assert_eq!(gets(), before);
    // A cancelled fetch leaves nothing.
    let cancelled = AtomicBool::new(true);
    let err = a
        .sync
        .ensure_local(&m.id, &segments[1..2], &cancelled)
        .unwrap_err();
    assert_eq!(err.kind, SyncErrorKind::Local);
    assert!(!m.path(&segments[1]).exists());
}

#[test]
fn ensure_local_fetches_a_file_once_and_keeps_text_on_disk() {
    let fake = fake();
    let data = scratch("restore-ensure-once");
    let _c = Cleanup(data.clone());
    let a = Voice::open(&data);
    let (m, segments) = finished(&a.meetings(), "Twice", 3_600_000);
    a.connect(&fake.endpoint());
    a.settle(&fake, WAIT);
    let key = a.key();
    let originals: Vec<Vec<u8>> = segments.iter().map(|s| m.read(s)).collect();
    fs::remove_dir_all(m.path("audio")).unwrap();

    // Four media-prepare threads ask for the same segments while the bucket answers slowly.
    fake.faults().stall = Some(Duration::from_millis(150));
    std::thread::scope(|scope| {
        let calls: Vec<_> = (0..4)
            .map(|_| {
                scope.spawn(|| {
                    a.sync
                        .ensure_local(&m.id, &segments, &AtomicBool::new(false))
                })
            })
            .collect();
        for call in calls {
            call.join().unwrap().unwrap();
        }
    });
    fake.faults().stall = None;
    for (s, original) in segments.iter().zip(&originals) {
        assert_eq!(&fs::read(m.path(s)).unwrap(), original, "{s}");
        assert!(!m.path(&format!("{s}.restore")).exists());
        let object = file_object(&key, &m.id, s, original);
        let gets = fake
            .log()
            .iter()
            .filter(|l| l.op == voice_s3_fake::Op::Get && unprefixed(&l.key) == object)
            .count();
        assert_eq!(gets, 1, "{s} came back once");
    }

    // A text file on disk that differs from its upload is newer, not damaged: it stays. With the
    // bucket unreachable, any fetch would fail.
    let uploaded = m.read("timeline.jsonl");
    m.line(serde_json::json!({"kind":"mark","t":1_200,"id":"k-1","label":null}));
    let local = m.read("timeline.jsonl");
    assert_ne!(local.len(), uploaded.len());
    fake.faults().refuse = true;
    a.sync
        .ensure_local(
            &m.id,
            &["timeline.jsonl".to_owned()],
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(m.read("timeline.jsonl"), local);
}

#[test]
fn the_shown_key_is_the_key_uploads_use() {
    let root = scratch("restore-key-race");
    let _c = Cleanup(root.clone());
    for round in 0..5 {
        // A bucket per round, so `settle` waits for this round's index.
        let fake = fake();
        let voice = Voice::open(&root.join(format!("v{round}")));
        let m = Meeting::new(&voice.meetings(), "Race", 60_000);
        let segment = m.segment("mic", 1, 0, 16_000);
        m.stop(1_000);
        // Sync turns on while Settings asks for the key: the worker and show_key find no key at
        // the same moment.
        voice.connect(&fake.endpoint());
        let shown: Vec<(String, String)> = std::thread::scope(|scope| {
            let calls: Vec<_> = (0..3)
                .map(|_| scope.spawn(|| voice.sync.show_key().unwrap()))
                .collect();
            calls.into_iter().map(|c| c.join().unwrap()).collect()
        });
        assert!(shown.windows(2).all(|w| w[0] == w[1]), "{shown:?}");
        let key = recovery::decode(&shown[0].0).unwrap();
        assert_eq!(key.kid(), voice.key().kid(), "the code is the key on disk");
        voice.settle(&fake, WAIT);
        let uploaded = uploaded_files(&fake, &key, &m, &["meeting.json", segment.as_str()]);
        assert_eq!(uploaded.len(), 2, "the code opens what went up");
    }
}

#[test]
fn an_unfinished_restore_is_cleared_at_start() {
    let data = scratch("restore-partial");
    let _c = Cleanup(data.clone());
    let meetings = data.join("meetings");
    let partial = meetings.join(".restore-m-20261101-120000-0001");
    let other = meetings.join(".restore-notes");
    let meeting = meetings.join("m-20261101-110000-0002");
    for dir in [&partial, &other, &meeting] {
        fs::create_dir_all(dir.join("audio")).unwrap();
        fs::write(dir.join("meeting.json"), b"{}").unwrap();
    }
    let voice = Voice::open(&data);
    assert!(!partial.exists(), "a restore a kill cut off leaves nothing");
    assert!(
        other.join("meeting.json").is_file(),
        "not a restore of a meeting id"
    );
    assert!(meeting.join("meeting.json").is_file());
    assert!(meeting.join("audio").is_dir());
    drop(voice);
}

/// Puts a manifest encrypted with `key` where the restore of `id` reads it, and an index entry.
fn plant(
    fake: &voice_s3_fake::FakeS3,
    key: &voice_sync::keys::MasterKey,
    id: &str,
    manifest: &Manifest,
) {
    let bucket = Bucket::new(
        &config(&fake.endpoint()),
        SECRET,
        Duration::from_secs(2),
        Duration::from_secs(10),
    )
    .unwrap();
    let object = manifest_object(key, id);
    bucket
        .put(
            &object,
            &seal(key, &object, &serde_json::to_vec(manifest).unwrap()),
        )
        .unwrap();
}

#[test]
fn restore_refuses_a_manifest_with_a_foreign_path() {
    let fake = fake();
    let root = scratch("restore-foreign");
    let _c = Cleanup(root.clone());
    let a = Voice::open(&root.join("a"));
    let (code, _) = a.sync.show_key().unwrap();
    let key = recovery::decode(&code).unwrap();
    let name_key = key.name_key();

    // A real meeting.json in the bucket, then manifests that name it and a path outside.
    let id = "m-20261101-120000-0001";
    let meeting_json = serde_json::to_vec(&serde_json::json!({
        "id": id, "title": "Evil", "createdAt": 1_793_000_000_000u64, "tracks": ["mic"],
        "screen": "off", "startedBy": "voice", "version": 1
    }))
    .unwrap();
    let bucket = Bucket::new(
        &config(&fake.endpoint()),
        SECRET,
        Duration::from_secs(2),
        Duration::from_secs(10),
    )
    .unwrap();
    let file = |path: &str, bytes: &[u8]| {
        let object = file_object(&key, id, "meeting.json", bytes);
        bucket.put(&object, &seal(&key, &object, bytes)).unwrap();
        ManifestFile {
            path: path.into(),
            kind: "meeting".into(),
            object,
            size: bytes.len() as u64,
            sha256: sha256_hex(bytes),
            track: None,
            seq: None,
            t: None,
            samples: None,
        }
    };
    let good = file("meeting.json", &meeting_json);
    let evil = file("../../evil.txt", b"not yours");
    let manifest = |meeting: &str, files: Vec<ManifestFile>| Manifest {
        v: 1,
        meeting: meeting.into(),
        gen: 1,
        state: "done".into(),
        updated_at: 1,
        media_removed_at: None,
        files,
    };

    let b = Voice::open(&root.join("b"));
    b.sync.import_key(&code).unwrap();
    b.connect(&fake.endpoint());
    let restore = |ids: Vec<String>| {
        let (_, on_restored) = recorder();
        b.sync.restore(ids, on_restored).unwrap();
        let state = wait_restore(&b, "failed");
        assert_eq!(state.error.as_deref(), Some(BAD_MANIFEST));
        no_partial_folders(&b);
        assert!(!root.join("evil.txt").exists());
        assert!(!b.data.join("evil.txt").exists());
        assert!(!b.meetings().join(id).exists());
    };

    plant(&fake, &key, id, &manifest(id, vec![good.clone(), evil]));
    restore(vec![id.to_owned()]);

    // A manifest that says it belongs to the meeting `..`.
    plant(&fake, &key, id, &manifest("..", vec![good.clone()]));
    restore(vec![id.to_owned()]);

    // The id `..` itself.
    let dots = manifest_object(&key, "..");
    assert_eq!(
        dots,
        voice_sync::names::manifest_object(
            &key.kid(),
            &voice_sync::names::meeting_hash(&name_key, "..")
        )
    );
    plant(&fake, &key, "..", &manifest("..", vec![good.clone()]));
    restore(vec!["..".to_owned()]);

    // The same manifest with only meeting.json restores.
    plant(&fake, &key, id, &manifest(id, vec![good]));
    let (_, on_restored) = recorder();
    b.sync.restore(vec![id.to_owned()], on_restored).unwrap();
    wait_restore(&b, "done");
    assert_eq!(
        fs::read(b.meetings().join(id).join("meeting.json")).unwrap(),
        meeting_json
    );
    assert!(
        b.meetings().join(id).join("timeline.jsonl").is_file(),
        "a timeline was made"
    );
}

#[test]
fn restore_stops_at_the_floor() {
    let fake = fake();
    let root = scratch("restore-floor");
    let _c = Cleanup(root.clone());
    let a = Voice::open(&root.join("a"));
    let (first, _) = finished(&a.meetings(), "First", 7_200_000);
    let (second, _) = finished(&a.meetings(), "Second", 3_600_000);
    a.connect(&fake.endpoint());
    a.settle(&fake, WAIT);
    let (code, _) = a.sync.show_key().unwrap();

    let room = Arc::new(AtomicBool::new(true));
    let r = room.clone();
    let b = Voice::with(
        &root.join("b"),
        Setup {
            reserve: Arc::new(move |_| r.load(Ordering::SeqCst)),
            ..Setup::default()
        },
    );
    b.sync.import_key(&code).unwrap();
    b.connect(&fake.endpoint());
    let r = room.clone();
    b.sync
        .restore(
            vec![first.id.clone(), second.id.clone()],
            Box::new(move |_| r.store(false, Ordering::SeqCst)),
        )
        .unwrap();
    let state = wait_restore(&b, "failed");
    assert_eq!(state.error.as_deref(), Some("Not enough free disk space."));
    assert_eq!((state.done, state.total), (1, 2));
    assert!(b.meetings().join(&first.id).join("meeting.json").is_file());
    assert!(!b.meetings().join(&second.id).exists());
    no_partial_folders(&b);
}
