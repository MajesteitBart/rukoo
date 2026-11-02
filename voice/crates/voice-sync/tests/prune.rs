//! Bucket retention and `forget_meeting` (spec 2.10).

mod harness;

use std::time::Duration;

use harness::*;
use voice_sync::{names, BucketRetention, SyncTiming};

const WAIT: Duration = Duration::from_secs(30);
const DAY: u64 = 86_400_000;

fn finished(meetings: &std::path::Path, title: &str, done_days_ago: u64) -> (Meeting, Vec<String>) {
    let m = Meeting::new(meetings, title, done_days_ago * DAY + 3_600_000);
    let segments = vec![
        m.segment("mic", 1, 0, 16_000),
        m.segment("call", 1, 0, 16_000),
    ];
    m.stop(1_000);
    m.transcript(
        &[("mic", 0, 900, "Kept text")],
        now_ms() - done_days_ago * DAY,
    );
    (m, segments)
}

#[test]
fn bucket_retention_removes_media_and_keeps_text() {
    let fake = fake();
    let data = scratch("prune-retention");
    let _c = Cleanup(data.clone());
    let voice = Voice::with(
        &data,
        Setup {
            timing: SyncTiming {
                prune_every: Duration::from_millis(200),
                ..timing()
            },
            ..Setup::default()
        },
    );
    let (old, old_audio) = finished(&voice.meetings(), "Old", 100);
    let (recent, recent_audio) = finished(&voice.meetings(), "Recent", 10);
    voice.connect(&fake.endpoint());
    voice.settle(&fake, WAIT);
    let key = voice.key();
    let object = |m: &Meeting, rel: &str| file_object(&key, &m.id, rel, &m.read(rel));
    for rel in &old_audio {
        assert!(
            has_object(&fake, &object(&old, rel)),
            "kept forever at first"
        );
    }
    let gen = manifest(&fake, &key, &old.id).unwrap().gen;

    let mut cfg = config(&fake.endpoint());
    cfg.retention = BucketRetention::Days90;
    voice.sync.configure(Some(cfg));
    let ok = wait_for(WAIT, || {
        old_audio
            .iter()
            .all(|rel| !has_object(&fake, &object(&old, rel)))
            && manifest(&fake, &key, &old.id).is_some_and(|m| m.gen > gen)
    });
    assert!(ok, "{:?}", fake.log());
    voice.settle(&fake, WAIT);

    // The old meeting's text stays; its manifest lists no media and says when it went.
    for rel in ["meeting.json", "timeline.jsonl"] {
        assert!(has_object(&fake, &object(&old, rel)), "{rel} stays");
    }
    let mf = manifest(&fake, &key, &old.id).unwrap();
    assert!(mf.media_removed_at.is_some());
    assert!(mf.files.iter().all(|f| f.kind != "audio"));
    for kind in ["meeting", "timeline", "transcript"] {
        let f = mf.files.iter().find(|f| f.kind == kind).unwrap();
        assert!(has_object(&fake, &f.object), "{kind}");
    }
    // The index says so too.
    let entry = indexes(&fake, &key)
        .into_iter()
        .flat_map(|i| i.meetings)
        .find(|e| e.id == old.id)
        .unwrap();
    assert!(entry.media_removed_at.is_some());
    assert_eq!(entry.gen, mf.gen);
    // A meeting done 10 days ago keeps everything.
    for rel in &recent_audio {
        assert!(has_object(&fake, &object(&recent, rel)));
    }
    assert!(manifest(&fake, &key, &recent.id)
        .unwrap()
        .media_removed_at
        .is_none());
    // Local files are untouched: bucket retention is about the bucket.
    for rel in &old_audio {
        assert!(old.path(rel).is_file());
    }
}

#[test]
fn forget_meeting_removes_every_object_and_marks_it_deleted() {
    let fake = fake();
    let data = scratch("prune-forget");
    let _c = Cleanup(data.clone());
    let voice = Voice::open(&data);
    let (gone, _) = finished(&voice.meetings(), "Gone", 2);
    let (kept, _) = finished(&voice.meetings(), "Kept", 1);
    voice.connect(&fake.endpoint());
    voice.settle(&fake, WAIT);
    let key = voice.key();
    let folder = |m: &Meeting| {
        format!(
            "rkv1/{}/m/{}/",
            key.kid(),
            names::meeting_hash(&key.name_key(), &m.id)
        )
    };
    let count = |m: &Meeting| {
        objects(&fake)
            .iter()
            .filter(|(k, _)| k.starts_with(&folder(m)))
            .count()
    };
    assert!(count(&gone) >= 5);
    let kept_before = count(&kept);

    // The meeting is deleted on this computer first, then forgotten in the bucket.
    std::fs::remove_dir_all(&gone.dir).unwrap();
    voice.sync.forget_meeting(&gone.id, true).unwrap();
    assert_eq!(count(&gone), 0, "every object of the meeting went");
    assert_eq!(count(&kept), kept_before);
    let ok = wait_for(WAIT, || {
        indexes(&fake, &key)
            .into_iter()
            .flat_map(|i| i.meetings)
            .any(|e| e.id == gone.id && e.deleted)
    });
    assert!(ok, "the next index marks it deleted");
    let index = indexes(&fake, &key);
    let kept_entry = index[0].meetings.iter().find(|e| e.id == kept.id).unwrap();
    assert!(!kept_entry.deleted);
    assert!(!voice.sync.holds_media(&gone.id));

    // Without deleting objects only the rows go.
    let before = objects(&fake).len();
    voice.sync.forget_meeting(&kept.id, false).unwrap();
    assert_eq!(objects(&fake).len(), before);
    assert!(!voice.sync.in_bucket(&kept.id, "meeting.json"));
}
