//! Meetings from the user's other computers (voice/README.md, Storage): a finished meeting comes in
//! as text, newer text replaces the old, a deletion reaches every computer, and a computer that
//! only followed a pulled meeting never sends it back.

mod harness;

use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use harness::*;
use voice_meetings::Transcript;
use voice_protocol::Passage;
use voice_s3_fake::{FakeS3, Op};
use voice_sync::{PullHooks, PullOrigin, SyncError};

const WAIT: Duration = Duration::from_secs(30);

/// What the engine would do: the meeting's pipeline follows it and notes in `emitted` what its
/// event log holds, under this computer's own sequence numbers.
#[derive(Default)]
struct Hooks {
    meetings: std::path::PathBuf,
    restored: Mutex<Vec<String>>,
    updated: Mutex<Vec<String>>,
    deleted: Mutex<Vec<String>>,
    /// `deleted` says the meeting can't go now.
    refuse_delete: Mutex<bool>,
}

impl Hooks {
    fn new(meetings: &Path) -> Arc<Hooks> {
        Arc::new(Hooks {
            meetings: meetings.to_owned(),
            ..Hooks::default()
        })
    }

    fn follow(&self, meeting: &str) {
        let t = Transcript::open(&self.meetings.join(meeting)).unwrap();
        for (i, p) in t.passages().unwrap().iter().enumerate() {
            let key = format!("passage:{}:{}", p.passage.id, p.passage.revision);
            t.record_emitted(&key, 9_000 + i as u64).unwrap();
        }
        t.record_emitted("started", 8_999).unwrap();
    }

    fn restored(&self) -> Vec<String> {
        self.restored.lock().unwrap().clone()
    }
    fn updated(&self) -> Vec<String> {
        self.updated.lock().unwrap().clone()
    }
    fn deleted(&self) -> Vec<String> {
        self.deleted.lock().unwrap().clone()
    }
}

impl PullHooks for Hooks {
    fn restored(&self, meeting: &str) {
        self.follow(meeting);
        self.restored.lock().unwrap().push(meeting.to_owned());
    }

    fn update(
        &self,
        meeting: &str,
        swap: &mut dyn FnMut() -> Result<(), SyncError>,
    ) -> Result<(), SyncError> {
        swap()?;
        self.follow(meeting);
        self.updated.lock().unwrap().push(meeting.to_owned());
        Ok(())
    }

    fn deleted(&self, meeting: &str, from: &PullOrigin<'_>) -> bool {
        if !from.holds() {
            return false;
        }
        if *self.refuse_delete.lock().unwrap() {
            return false;
        }
        // As the engine's deletion does, also for one that stopped after renaming the folder.
        let _ = fs::remove_dir_all(self.meetings.join(meeting));
        let _ = fs::remove_dir_all(self.meetings.join(format!(".deleted-{meeting}")));
        self.deleted.lock().unwrap().push(meeting.to_owned());
        true
    }
}

/// A finished meeting with a segment per track and a transcript.
fn finished(meetings: &Path, title: &str, ago: u64) -> (Meeting, Vec<String>) {
    let m = Meeting::new(meetings, title, ago);
    let segments = vec![
        m.segment("mic", 1, 0, 16_000),
        m.segment("call", 1, 3, 16_000),
    ];
    m.stop(1_003);
    m.transcript(
        &[
            ("mic", 0, 400, "First thing"),
            ("call", 500, 900, "Second thing"),
        ],
        now_ms() - ago / 2,
    );
    (m, segments)
}

/// Computer B with A's key, connected and pulling.
fn second_computer(fake: &FakeS3, root: &Path, a: &Voice, setup: Setup) -> (Voice, Arc<Hooks>) {
    let (code, _) = a.sync.show_key().unwrap();
    let b = Voice::with(&root.join("b"), setup);
    b.sync.import_key(&code).unwrap();
    let hooks = Hooks::new(&b.meetings());
    b.sync.set_pull_hooks(hooks.clone());
    b.connect(&fake.endpoint());
    (b, hooks)
}

/// Computer A with one finished meeting in the bucket, and computer B pulling.
fn two_computers(
    fake: &FakeS3,
    root: &Path,
    title: &str,
) -> (Voice, Voice, Arc<Hooks>, Meeting, Vec<String>) {
    let a = Voice::open(&root.join("a"));
    let (m, segments) = finished(&a.meetings(), title, 3_600_000);
    a.connect(&fake.endpoint());
    a.settle(fake, WAIT);
    let (b, hooks) = second_computer(fake, root, &a, Setup::default());
    (a, b, hooks, m, segments)
}

/// The objects PUT so far.
fn puts(fake: &FakeS3) -> Vec<String> {
    fake.log()
        .into_iter()
        .filter(|l| l.op == Op::Put && l.status == 200)
        .map(|l| unprefixed(&l.key).to_owned())
        .collect()
}

/// Changes a passage's text, as a microphone split would.
fn rewrite(dir: &Path, start: u64, text: &str) {
    let t = Transcript::open(dir).unwrap();
    let stored = t
        .passages()
        .unwrap()
        .into_iter()
        .find(|p| p.passage.start == start)
        .unwrap();
    t.update_passage(&Passage {
        text: text.to_owned(),
        revision: stored.passage.revision + 1,
        ..stored.passage
    })
    .unwrap();
}

#[test]
fn a_finished_meeting_from_another_computer_comes_in_as_text() {
    let fake = fake();
    let root = scratch("pull-text");
    let _c = Cleanup(root.clone());
    let (_a, b, hooks, m, segments) = two_computers(&fake, &root, "Weekly with Anna");
    assert!(
        wait_for(WAIT, || hooks.restored() == vec![m.id.clone()]),
        "the meeting never came: {:?}",
        b.sync.status()
    );
    let dir = b.meetings().join(&m.id);
    assert_eq!(
        fs::read(dir.join("meeting.json")).unwrap(),
        m.read("meeting.json")
    );
    assert_eq!(Meeting::passages(&dir), Meeting::passages(&m.dir));
    // Media stays in the bucket until something asks for it.
    assert!(!dir.join("audio").exists());
    for s in &segments {
        assert!(b.sync.in_bucket(&m.id, s), "{s}");
    }
    assert!(wait_for(WAIT, || b.sync.status().pull.at.is_some()));
    assert!(wait_for(WAIT, || b.sync.status().restore.available == 0));
}

#[test]
fn following_a_pulled_meeting_sends_nothing_back() {
    let fake = fake();
    let root = scratch("pull-no-echo");
    let _c = Cleanup(root.clone());
    let (_a, _b, hooks, m, _) = two_computers(&fake, &root, "Planning");
    assert!(wait_for(WAIT, || hooks.restored() == vec![m.id.clone()]));
    let before = puts(&fake).len();
    // A few full scans: each snapshots the transcript B's pipeline wrote to.
    std::thread::sleep(Duration::from_millis(1_500));
    let after: Vec<String> = puts(&fake).split_off(before);
    assert!(
        after.iter().all(|k| !k.contains("/m/")),
        "B uploaded the meeting again: {after:?}"
    );
}

#[test]
fn a_meeting_that_hasnt_finished_stays_on_its_computer() {
    let fake = fake();
    let root = scratch("pull-live");
    let _c = Cleanup(root.clone());
    let a = Voice::open(&root.join("a"));
    let (done, _) = finished(&a.meetings(), "Done earlier", 7_200_000);
    a.connect(&fake.endpoint());
    a.settle(&fake, WAIT);
    // Stopped, but not transcribed yet: its manifest and the index say `processing`.
    let processing = Meeting::new(&a.meetings(), "Still transcribing", 60_000);
    processing.segment("mic", 1, 0, 16_000);
    processing.stop(1_000);
    a.sync.nudge();
    assert!(wait_for(WAIT, || indexes(&fake, &a.key()).iter().any(
        |i| i
            .meetings
            .iter()
            .any(|e| e.id == processing.id && e.state == "processing")
    )));
    let (b, hooks) = second_computer(&fake, &root, &a, Setup::default());
    assert!(wait_for(WAIT, || hooks.restored() == vec![done.id.clone()]));
    assert!(wait_for(WAIT, || b.sync.status().pull.at.is_some()));
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(hooks.restored(), vec![done.id.clone()]);
    assert!(!b.meetings().join(&processing.id).exists());
    // A restore can still bring it, for a computer that was lost before it finished.
    assert_eq!(b.sync.status().restore.available, 1);

    processing.transcript(&[("mic", 0, 900, "Done now")], now_ms());
    assert!(
        wait_for(WAIT, || hooks.restored().contains(&processing.id)),
        "it never came once it finished: {:?}",
        b.sync.status()
    );
}

#[test]
fn newer_text_from_another_computer_replaces_the_old() {
    let fake = fake();
    let root = scratch("pull-update");
    let _c = Cleanup(root.clone());
    let (a, b, hooks, m, _) = two_computers(&fake, &root, "Review");
    assert!(wait_for(WAIT, || hooks.restored() == vec![m.id.clone()]));
    let gen = manifest(&fake, &a.key(), &m.id).unwrap().gen;

    rewrite(&m.dir, 500, "Second thing, settled");
    assert!(
        wait_for(WAIT, || hooks.updated() == vec![m.id.clone()]),
        "B never took the newer text: {:?}",
        b.sync.status()
    );
    let dir = b.meetings().join(&m.id);
    assert_eq!(Meeting::passages(&dir), Meeting::passages(&m.dir));
    let newer = manifest(&fake, &a.key(), &m.id).unwrap().gen;
    assert!(newer > gen);
    // B followed the new text: still nothing goes back.
    std::thread::sleep(Duration::from_millis(1_500));
    assert_eq!(manifest(&fake, &a.key(), &m.id).unwrap().gen, newer);
    assert_eq!(hooks.updated().len(), 1);
}

#[test]
fn a_change_made_on_the_pulling_computer_goes_back() {
    let fake = fake();
    let root = scratch("pull-back");
    let _c = Cleanup(root.clone());
    let (a, b, hooks, m, _) = two_computers(&fake, &root, "Split here");
    assert!(wait_for(WAIT, || hooks.restored() == vec![m.id.clone()]));
    let a_hooks = Hooks::new(&a.meetings());
    a.sync.set_pull_hooks(a_hooks.clone());
    let gen = manifest(&fake, &a.key(), &m.id).unwrap().gen;

    let dir = b.meetings().join(&m.id);
    rewrite(&dir, 0, "First thing, from Anna");
    assert!(
        wait_for(WAIT, || a_hooks.updated() == vec![m.id.clone()]),
        "A never took B's change: {:?}",
        a.sync.status()
    );
    assert_eq!(Meeting::passages(&m.dir), Meeting::passages(&dir));
    assert!(manifest(&fake, &a.key(), &m.id).unwrap().gen > gen);
    // A recorded it, and its audio is still its own.
    assert!(m.path("audio/mic/000001.wav").exists());
    let _ = b;
}

#[test]
fn a_deletion_on_one_computer_deletes_the_meeting_on_the_other() {
    let fake = fake();
    let root = scratch("pull-delete");
    let _c = Cleanup(root.clone());
    let (a, b, hooks, m, _) = two_computers(&fake, &root, "Gone soon");
    assert!(wait_for(WAIT, || hooks.restored() == vec![m.id.clone()]));
    *hooks.refuse_delete.lock().unwrap() = true;

    a.sync.mark_deleted(&m.id, None).unwrap();
    fs::remove_dir_all(&m.dir).unwrap();
    assert!(wait_for(WAIT, || indexes(&fake, &a.key())
        .iter()
        .any(|i| i.meetings.iter().any(|e| e.id == m.id && e.deleted))));
    // Busy here: it stays, and the next pull tries again.
    std::thread::sleep(Duration::from_millis(600));
    assert!(b.meetings().join(&m.id).exists());
    *hooks.refuse_delete.lock().unwrap() = false;
    assert!(
        wait_for(WAIT, || hooks.deleted() == vec![m.id.clone()]),
        "B kept the meeting: {:?}",
        b.sync.status()
    );
    assert!(!b.meetings().join(&m.id).exists());
    // It doesn't come back.
    std::thread::sleep(Duration::from_millis(600));
    assert_eq!(hooks.restored().len(), 1);
}

#[test]
fn asking_pulls_at_once() {
    let fake = fake();
    let root = scratch("pull-now");
    let _c = Cleanup(root.clone());
    let a = Voice::open(&root.join("a"));
    a.connect(&fake.endpoint());
    let (b, hooks) = second_computer(
        &fake,
        &root,
        &a,
        Setup {
            timing: voice_sync::SyncTiming {
                pull_every: Duration::from_secs(3_600),
                ..timing()
            },
            ..Setup::default()
        },
    );
    assert!(wait_for(WAIT, || b.sync.status().pull.at.is_some()));
    let first = b.sync.status().pull.at;

    let (m, _) = finished(&a.meetings(), "Later", 60_000);
    a.settle(&fake, WAIT);
    std::thread::sleep(Duration::from_millis(400));
    assert!(hooks.restored().is_empty(), "an hourly pull came early");
    b.sync.pull_now();
    assert!(wait_for(WAIT, || hooks.restored() == vec![m.id.clone()]));
    assert!(b.sync.status().pull.at > first);
}

#[test]
fn a_meeting_that_only_shares_an_id_is_never_touched() {
    let fake = fake();
    let root = scratch("pull-same-id");
    let _c = Cleanup(root.clone());
    let a = Voice::open(&root.join("a"));
    let (m, _) = finished(&a.meetings(), "Theirs", 3_600_000);
    a.connect(&fake.endpoint());
    a.settle(&fake, WAIT);
    // B recorded another meeting that got the same id, a millisecond later.
    let b_root = root.join("b");
    let mine = b_root.join("meetings").join(&m.id);
    fs::create_dir_all(&mine).unwrap();
    let mut file: serde_json::Value = serde_json::from_slice(&m.read("meeting.json")).unwrap();
    file["createdAt"] = (m.created_at + 1).into();
    file["title"] = "Mine".into();
    fs::write(
        mine.join("meeting.json"),
        serde_json::to_vec(&file).unwrap(),
    )
    .unwrap();
    let (b, hooks) = second_computer(&fake, &root, &a, Setup::default());
    assert!(wait_for(WAIT, || b.sync.status().pull.at.is_some()));

    a.sync.mark_deleted(&m.id, None).unwrap();
    fs::remove_dir_all(&m.dir).unwrap();
    assert!(wait_for(WAIT, || indexes(&fake, &a.key())
        .iter()
        .any(|i| i.meetings.iter().any(|e| e.id == m.id && e.deleted))));
    let pulled = b.sync.status().pull.at;
    assert!(wait_for(WAIT, || b.sync.status().pull.at > pulled));
    assert!(hooks.deleted().is_empty());
    assert!(hooks.updated().is_empty());
    let kept: serde_json::Value =
        serde_json::from_slice(&fs::read(mine.join("meeting.json")).unwrap()).unwrap();
    assert_eq!(kept["title"], "Mine");
}

#[test]
fn two_computers_that_publish_the_same_version_end_with_the_same_text() {
    let fake = fake();
    let root = scratch("pull-concurrent");
    let _c = Cleanup(root.clone());
    let slow = || Setup {
        timing: voice_sync::SyncTiming {
            pull_every: Duration::from_secs(3_600),
            ..timing()
        },
        ..Setup::default()
    };
    let a = Voice::with(&root.join("a"), slow());
    let (m, _) = finished(&a.meetings(), "Both at once", 3_600_000);
    a.connect(&fake.endpoint());
    a.settle(&fake, WAIT);
    let a_hooks = Hooks::new(&a.meetings());
    a.sync.set_pull_hooks(a_hooks.clone());
    let (b, b_hooks) = second_computer(&fake, &root, &a, slow());
    assert!(wait_for(WAIT, || b_hooks.restored() == vec![m.id.clone()]));
    let gen = manifest(&fake, &a.key(), &m.id).unwrap().gen;
    let b_dir = b.meetings().join(&m.id);

    // Each changes the meeting before it hears of the other's change.
    rewrite(&m.dir, 0, "First thing, as A heard it");
    rewrite(&b_dir, 0, "First thing, as B heard it");
    a.sync.nudge();
    b.sync.nudge();
    assert!(wait_for(WAIT, || {
        let ups = puts(&fake);
        ups.iter().filter(|k| k.ends_with("/manifest")).count() >= 3
            && indexes(&fake, &a.key())
                .iter()
                .filter(|i| i.meetings.iter().any(|e| e.id == m.id && e.gen == gen + 1))
                .count()
                == 2
    }));
    // A few looks on each side: they settle on whichever manifest went up last.
    let ok = wait_for(WAIT, || {
        a.sync.pull_now();
        b.sync.pull_now();
        std::thread::sleep(Duration::from_millis(150));
        Meeting::passages(&m.dir) == Meeting::passages(&b_dir)
    });
    assert!(
        ok,
        "A: {:?}\nB: {:?}",
        Meeting::passages(&m.dir),
        Meeting::passages(&b_dir)
    );
    let text = &Meeting::passages(&m.dir)[0].2;
    assert!(text.ends_with("as A heard it") || text.ends_with("as B heard it"));
    // And it stays that way.
    std::thread::sleep(Duration::from_millis(800));
    a.sync.pull_now();
    b.sync.pull_now();
    std::thread::sleep(Duration::from_millis(800));
    assert_eq!(Meeting::passages(&m.dir), Meeting::passages(&b_dir));
}

#[test]
fn a_replacement_a_crash_cut_off_goes_on_at_the_next_start() {
    let root = scratch("pull-finish");
    let _c = Cleanup(root.clone());
    let data = root.join("b");
    let (m, newer) = {
        let b = Voice::open(&data);
        let (m, _) = finished(&b.meetings(), "Halfway", 3_600_000);
        // What a pull fetched: the same meeting with newer text, in the update folder.
        let other = scratch("pull-finish-other");
        let n = Meeting::new(&other, "Halfway", 3_600_000);
        n.transcript(&[("mic", 0, 400, "Newer text")], now_ms());
        let tmp = b.meetings().join(format!(".update-{}", m.id));
        fs::create_dir_all(tmp.join("files")).unwrap();
        fs::copy(
            n.path("transcript.db"),
            tmp.join("files").join("transcript.db"),
        )
        .unwrap();
        let newer = Meeting::passages(&n.dir);
        fs::remove_dir_all(&other).unwrap();
        let journal = serde_json::json!({
            "paths": ["transcript.db"],
            "manifest": {"v": 1, "meeting": m.id, "gen": 2, "state": "done", "updatedAt": 0,
                         "mediaRemovedAt": null, "files": []},
            "manifestId": "0".repeat(64), "mhash": "0".repeat(32), "target": "elsewhere", "kid": "k"
        });
        fs::write(tmp.join("install.json"), journal.to_string()).unwrap();
        // The crash came after the old write-ahead log went.
        let _ = fs::remove_file(m.path("transcript.db-wal"));
        (m, newer)
    };
    let b = Voice::open(&data);
    assert_eq!(Meeting::passages(&m.dir), newer);
    assert!(m.path(".pulled").is_file(), "the engine follows it again");
    // Until a pull notes the version, the worker leaves the meeting alone.
    let tmp = b.meetings().join(format!(".update-{}", m.id));
    assert!(voice_sync::pull::pending_install(&b.meetings(), &m.id));
    assert!(!tmp.join("files").join("transcript.db").exists());
    drop(b);

    // An update folder without its list never replaced anything: it just goes.
    fs::remove_file(tmp.join("install.json")).unwrap();
    fs::create_dir_all(tmp.join("files")).unwrap();
    fs::write(tmp.join("files").join("transcript.db"), b"half a download").unwrap();
    let _b = Voice::open(&data);
    assert!(!tmp.exists());
    assert_eq!(Meeting::passages(&m.dir), newer);
}

#[test]
fn newer_text_a_crash_left_unnoted_is_noted_and_never_sent_back() {
    let fake = fake();
    let root = scratch("pull-unnoted");
    let _c = Cleanup(root.clone());
    let slow = || Setup {
        timing: voice_sync::SyncTiming {
            pull_every: Duration::from_secs(3_600),
            ..timing()
        },
        ..Setup::default()
    };
    let a = Voice::open(&root.join("a"));
    let (m, _) = finished(&a.meetings(), "Unnoted", 3_600_000);
    a.connect(&fake.endpoint());
    a.settle(&fake, WAIT);
    let (b, hooks) = second_computer(&fake, &root, &a, slow());
    assert!(wait_for(WAIT, || hooks.restored() == vec![m.id.clone()]));
    let dir = b.meetings().join(&m.id);

    rewrite(&m.dir, 500, "Second thing, settled");
    let gen = manifest(&fake, &a.key(), &m.id).unwrap().gen;
    assert!(wait_for(WAIT, || manifest(&fake, &a.key(), &m.id)
        .is_some_and(|x| x.gen > gen)
        && indexes(&fake, &a.key()).iter().any(|i| i
            .meetings
            .iter()
            .any(|e| e.id == m.id && e.gen > gen))));
    let newer = manifest(&fake, &a.key(), &m.id).unwrap().gen;
    // B crashed after the newer transcript was in place, before its version was noted.
    let _ = fs::remove_file(dir.join("transcript.db-wal"));
    let _ = fs::remove_file(dir.join("transcript.db-shm"));
    fs::remove_file(dir.join("transcript.db")).unwrap();
    // As a pull stages it: a consistent snapshot of A's transcript.
    rusqlite::Connection::open(m.path("transcript.db"))
        .unwrap()
        .execute(
            "VACUUM INTO ?1",
            [dir.join("transcript.db").to_str().unwrap()],
        )
        .unwrap();
    let tmp = b.meetings().join(format!(".update-{}", m.id));
    fs::create_dir_all(tmp.join("files")).unwrap();
    let key = a.key();
    let journal = serde_json::json!({
        "paths": ["transcript.db"],
        "manifest": manifest(&fake, &key, &m.id).unwrap(),
        "manifestId": "f".repeat(64),
        "mhash": voice_sync::names::meeting_hash(&key.name_key(), &m.id),
        "target": config(&fake.endpoint()).target(),
        "kid": key.kid(),
        "transcriptDigest": voice_sync::digest::transcript_digest(&dir.join("transcript.db")).unwrap(),
    });
    fs::write(tmp.join("install.json"), journal.to_string()).unwrap();
    let before = puts(&fake).len();
    // The worker's scans leave it alone meanwhile.
    std::thread::sleep(Duration::from_millis(800));
    b.sync.pull_now();
    assert!(
        wait_for(WAIT, || !tmp.exists()),
        "the version was never noted: {:?}",
        b.sync.status()
    );
    std::thread::sleep(Duration::from_millis(800));
    let sent: Vec<String> = puts(&fake)
        .split_off(before)
        .into_iter()
        .filter(|k| k.contains("/m/"))
        .collect();
    assert!(sent.is_empty(), "B sent the newer text back: {sent:?}");
    assert_eq!(manifest(&fake, &a.key(), &m.id).unwrap().gen, newer);
    assert_eq!(Meeting::passages(&dir), Meeting::passages(&m.dir));
}

#[test]
fn a_deletion_that_stopped_halfway_goes_on() {
    let fake = fake();
    let root = scratch("pull-delete-halfway");
    let _c = Cleanup(root.clone());
    let (a, b, hooks, m, _) = two_computers(&fake, &root, "Half gone");
    assert!(wait_for(WAIT, || hooks.restored() == vec![m.id.clone()]));
    // B's deletion renamed the folder and stopped there.
    let pending = b.meetings().join(format!(".deleted-{}", m.id));
    fs::rename(b.meetings().join(&m.id), &pending).unwrap();
    a.sync.mark_deleted(&m.id, None).unwrap();
    fs::remove_dir_all(&m.dir).unwrap();
    assert!(
        wait_for(WAIT, || hooks.deleted() == vec![m.id.clone()]),
        "B left the deletion halfway: {:?}",
        b.sync.status()
    );
    assert!(!pending.exists());
    std::thread::sleep(Duration::from_millis(600));
    assert_eq!(hooks.restored().len(), 1, "it doesn't come back");
}

#[test]
fn a_replacement_left_from_another_bucket_lets_the_meeting_go_up_to_this_one() {
    let fake = fake();
    let root = scratch("pull-elsewhere");
    let _c = Cleanup(root.clone());
    let a = Voice::open(&root.join("a"));
    let (m, _) = finished(&a.meetings(), "Moved buckets", 3_600_000);
    // A replacement for another bucket stopped before its version was noted.
    let tmp = a.meetings().join(format!(".update-{}", m.id));
    fs::create_dir_all(tmp.join("files")).unwrap();
    let journal = serde_json::json!({
        "paths": ["transcript.db"],
        "manifest": {"v": 1, "meeting": m.id, "gen": 2, "state": "done", "updatedAt": 0,
                     "mediaRemovedAt": null, "files": []},
        "manifestId": "0".repeat(64), "mhash": "0".repeat(32), "target": "another bucket", "kid": "k"
    });
    fs::write(tmp.join("install.json"), journal.to_string()).unwrap();
    a.connect(&fake.endpoint());
    a.settle(&fake, WAIT);
    assert!(!tmp.exists());
    assert!(
        manifest(&fake, &a.key(), &m.id).is_some(),
        "it went up to this bucket"
    );
}

#[test]
fn a_replacement_whose_file_is_neither_staged_nor_in_place_is_let_go() {
    let root = scratch("pull-half-staged");
    let _c = Cleanup(root.clone());
    let data = root.join("b");
    let (m, before) = {
        let b = Voice::open(&data);
        let (m, _) = finished(&b.meetings(), "Half staged", 3_600_000);
        let tmp = b.meetings().join(format!(".update-{}", m.id));
        fs::create_dir_all(tmp.join("files")).unwrap();
        // The journal names a transcript that isn't staged, and the one in place isn't it.
        let journal = serde_json::json!({
            "paths": ["transcript.db"],
            "manifest": {"v": 1, "meeting": m.id, "gen": 2, "state": "done", "updatedAt": 0,
                         "mediaRemovedAt": null, "files": [{"path": "transcript.db", "kind": "transcript",
                         "object": "o", "size": 1, "sha256": "0".repeat(64)}]},
            "manifestId": "0".repeat(64), "mhash": "0".repeat(32), "target": "t", "kid": "k"
        });
        fs::write(tmp.join("install.json"), journal.to_string()).unwrap();
        let before = Meeting::passages(&m.dir);
        (m, before)
    };
    let b = Voice::open(&data);
    assert!(!b.meetings().join(format!(".update-{}", m.id)).exists());
    assert!(!voice_sync::pull::pending_install(&b.meetings(), &m.id));
    assert_eq!(Meeting::passages(&m.dir), before);
}
