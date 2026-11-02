//! Hard kills mid-upload and the resume after them (spec 4.3, acceptance criterion 4).
//!
//! This binary has its own main (`harness = false`) so it can also be the uploader: run with
//! `VOICE_SYNC_TEST_ROLE=worker` it runs a `BucketSync` against the endpoint and data folder in its
//! arguments, and the parent kills it with `Child::kill`.

mod harness;

use std::io::{BufRead, BufReader};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitCode, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use harness::*;
use voice_s3_fake::{FakeS3, Op};
use voice_sync::keys::MasterKey;
use voice_sync::SyncState;

const ROLE: &str = "VOICE_SYNC_TEST_ROLE";
const WAIT: Duration = Duration::from_secs(120);
const MIB: usize = 1 << 20;

fn main() -> ExitCode {
    if std::env::var(ROLE).as_deref() == Ok("worker") {
        let mut args = std::env::args().skip(1);
        let endpoint = args.next().expect("endpoint");
        let data = PathBuf::from(args.next().expect("data folder"));
        worker(&endpoint, &data);
        return ExitCode::SUCCESS;
    }
    let filter: Vec<String> = std::env::args()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .collect();
    let cases: [(&str, fn()); 4] = [
        (
            "a_killed_multipart_upload_resumes_without_finished_parts",
            a_killed_multipart_upload_resumes_without_finished_parts,
        ),
        (
            "a_kill_after_the_bucket_answered_leaves_one_object",
            a_kill_after_the_bucket_answered_leaves_one_object,
        ),
        (
            "a_forgotten_upload_starts_again",
            a_forgotten_upload_starts_again,
        ),
        ("r2_part_rule_holds", r2_part_rule_holds),
    ];
    let mut failed = 0;
    let mut ran = 0;
    for (name, case) in cases {
        if !filter.is_empty() && !filter.iter().any(|f| name.contains(f.as_str())) {
            continue;
        }
        ran += 1;
        println!("test {name} ...");
        match catch_unwind(AssertUnwindSafe(case)) {
            Ok(()) => println!("test {name} ... ok"),
            Err(_) => {
                println!("test {name} ... FAILED");
                failed += 1;
            }
        }
    }
    println!(
        "\ntest result: {}. {} passed; {failed} failed",
        if failed == 0 { "ok" } else { "FAILED" },
        ran - failed
    );
    if failed == 0 {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

/// The child: syncs the data folder and prints its state whenever it changes.
fn worker(endpoint: &str, data: &Path) {
    let voice = Voice::with(
        data,
        Setup {
            screen: Arc::new(TestScreen),
            ..Setup::default()
        },
    );
    voice.connect(endpoint);
    let mut last = String::new();
    loop {
        let s = voice.sync.status();
        let line = format!("state={:?} waiting={}", s.state, s.waiting);
        if line != last {
            println!("{line}");
            last = line;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// A child uploader and the lines it printed.
struct Uploader {
    child: Child,
    lines: Arc<Mutex<Vec<String>>>,
}

impl Uploader {
    fn start(fake: &FakeS3, data: &Path) -> Uploader {
        let mut child = Command::new(std::env::current_exe().unwrap())
            .env(ROLE, "worker")
            .arg(fake.endpoint())
            .arg(data)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let lines = Arc::new(Mutex::new(Vec::new()));
        let out = child.stdout.take().unwrap();
        let l = lines.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                l.lock().unwrap().push(line);
            }
        });
        Uploader { child, lines }
    }

    fn idle(&self) -> bool {
        self.lines
            .lock()
            .unwrap()
            .last()
            .is_some_and(|l| l == &format!("state={:?} waiting=0", SyncState::Idle))
    }

    /// `Child::kill`: TerminateProcess on Windows, SIGKILL elsewhere.
    fn kill(mut self) {
        self.child.kill().unwrap();
        self.child.wait().unwrap();
    }
}

impl Drop for Uploader {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// A finished meeting whose only large file is a stand-in video of `len` bytes.
fn meeting_with_video(data: &Path, len: usize) -> Meeting {
    std::fs::create_dir_all(data.join("meetings")).unwrap();
    let m = Meeting::new(&data.join("meetings"), "Video", 600_000);
    m.stop(1_000);
    write(&m, "screen/video/000001.mp4", &mp4(len));
    write(&m, "screen/video/000001.mp4.closed", b"");
    m
}

/// The key the child made, once it made one.
fn child_key(data: &Path) -> MasterKey {
    let ok = wait_for(WAIT, || {
        data.join("sync").join(voice_sync::keys::KEY_FILE).is_file()
    });
    assert!(ok, "the child made a key");
    std::thread::sleep(Duration::from_millis(100));
    key_of(data)
}

fn answered(fake: &FakeS3, op: Op, object: &str, part: Option<u16>, status: u16) -> usize {
    fake.log()
        .iter()
        .filter(|l| {
            l.op == op
                && unprefixed(&l.key) == object
                && (part.is_none() || l.part == part)
                && l.status == status
        })
        .count()
}

fn wait_settled(fake: &FakeS3, uploader: &Uploader, object: &str) {
    let ok = wait_for(WAIT, || {
        uploader.idle() && has_object(fake, object) && index_after_last_manifest(fake)
    });
    assert!(
        ok,
        "the child settled: {:?}\n{:?}",
        uploader.lines.lock().unwrap().last(),
        fake.log()
    );
}

fn a_killed_multipart_upload_resumes_without_finished_parts() {
    let fake = fake();
    let data = scratch("resume-multipart");
    let _c = Cleanup(data.clone());
    // 39 MiB of plaintext: five parts of 8 MiB, the last one shorter.
    let m = meeting_with_video(&data, 39 * MIB);
    let video = m.read("screen/video/000001.mp4");
    fake.faults().stall = Some(Duration::from_millis(300));
    let first = Uploader::start(&fake, &data);
    let key = child_key(&data);
    let object = file_object(&key, &m.id, "screen/video/000001.mp4", &video);
    let ok = wait_for(WAIT, || {
        answered(&fake, Op::UploadPart, &object, Some(3), 200) >= 1
    });
    assert!(ok, "part 3 went up: {:?}", fake.log());
    first.kill();
    fake.faults().stall = None;
    assert!(!has_object(&fake, &object));

    let second = Uploader::start(&fake, &data);
    wait_settled(&fake, &second, &object);
    second.kill();

    assert_eq!(
        answered(&fake, Op::Create, &object, None, 200),
        1,
        "one Create"
    );
    assert_eq!(
        answered(&fake, Op::Complete, &object, None, 200),
        1,
        "one Complete"
    );
    assert!(
        answered(&fake, Op::ListParts, &object, None, 200) >= 1,
        "the resume asked"
    );
    for part in 1..=3 {
        assert_eq!(
            answered(&fake, Op::UploadPart, &object, Some(part), 200),
            1,
            "part {part} went up once"
        );
    }
    assert!(answered(&fake, Op::UploadPart, &object, Some(4), 200) <= 2);
    assert_eq!(
        answered(&fake, Op::UploadPart, &object, Some(5), 200).min(1),
        1
    );
    assert_eq!(
        answered(&fake, Op::UploadPart, &object, Some(6), 200),
        0,
        "five parts"
    );
    let stored: Vec<_> = fake
        .objects()
        .into_iter()
        .filter(|(k, _)| unprefixed(k) == object)
        .collect();
    assert_eq!(stored.len(), 1);
    assert_eq!(decrypt(&key, &object, &stored[0].1), video);
}

fn a_kill_after_the_bucket_answered_leaves_one_object() {
    let fake = fake();
    let data = scratch("resume-put");
    let _c = Cleanup(data.clone());
    std::fs::create_dir_all(data.join("meetings")).unwrap();
    let m = Meeting::new(&data.join("meetings"), "Put", 600_000);
    m.segment("mic", 1, 0, 16_000);
    m.stop(1_000);
    let meeting_json = m.read("meeting.json");
    fake.faults().stall = Some(Duration::from_millis(400));
    let first = Uploader::start(&fake, &data);
    let key = child_key(&data);
    let object = file_object(&key, &m.id, "meeting.json", &meeting_json);
    // The bucket has the object; the child is killed before it can note that.
    let ok = wait_for(WAIT, || has_object(&fake, &object));
    assert!(ok, "meeting.json went up");
    first.kill();
    let stored = |fake: &FakeS3| -> Vec<Vec<u8>> {
        fake.objects()
            .into_iter()
            .filter(|(k, _)| unprefixed(k) == object)
            .map(|(_, v)| v)
            .collect()
    };
    let before = stored(&fake);
    assert_eq!(before.len(), 1);
    fake.faults().stall = None;

    let second = Uploader::start(&fake, &data);
    wait_settled(&fake, &second, &object);
    second.kill();
    let after = stored(&fake);
    assert_eq!(after.len(), 1, "the name appears once");
    assert_eq!(after[0], before[0], "a retry sends the same bytes");
    let puts = answered(&fake, Op::Put, &object, None, 200);
    assert!((1..=2).contains(&puts), "{puts} PUTs");
    println!("  meeting.json went up {puts} times");
    assert_eq!(decrypt(&key, &object, &after[0]), meeting_json);
}

fn a_forgotten_upload_starts_again() {
    let fake = fake();
    let data = scratch("resume-forgotten");
    let _c = Cleanup(data.clone());
    let m = meeting_with_video(&data, 20 * MIB);
    let video = m.read("screen/video/000001.mp4");
    fake.faults().stall = Some(Duration::from_millis(250));
    let first = Uploader::start(&fake, &data);
    let key = child_key(&data);
    let object = file_object(&key, &m.id, "screen/video/000001.mp4", &video);
    let ok = wait_for(WAIT, || {
        answered(&fake, Op::UploadPart, &object, Some(1), 200) >= 1
    });
    assert!(ok, "part 1 went up");
    first.kill();
    // The bucket aborts the upload, as R2 does after 7 days.
    fake.faults().forget_uploads = true;

    let second = Uploader::start(&fake, &data);
    let ok = wait_for(WAIT, || {
        fake.log()
            .iter()
            .any(|l| unprefixed(&l.key) == object && l.status == 404)
    });
    assert!(ok, "the resume found no upload: {:?}", fake.log());
    {
        let mut faults = fake.faults();
        faults.forget_uploads = false;
        faults.stall = None;
    }
    wait_settled(&fake, &second, &object);
    second.kill();
    assert_eq!(
        answered(&fake, Op::Create, &object, None, 200),
        2,
        "a new Create"
    );
    assert_eq!(answered(&fake, Op::Complete, &object, None, 200), 1);
    let stored: Vec<_> = fake
        .objects()
        .into_iter()
        .filter(|(k, _)| unprefixed(k) == object)
        .collect();
    assert_eq!(stored.len(), 1);
    assert_eq!(decrypt(&key, &object, &stored[0].1), video);
}

fn r2_part_rule_holds() {
    let fake = fake();
    fake.faults().r2_parts = true;
    let data = scratch("resume-r2");
    let _c = Cleanup(data.clone());
    let m = meeting_with_video(&data, 21 * MIB + 12_345);
    let video = m.read("screen/video/000001.mp4");
    let voice = Voice::with(
        &data,
        Setup {
            screen: Arc::new(TestScreen),
            ..Setup::default()
        },
    );
    voice.connect(&fake.endpoint());
    voice.settle(&fake, WAIT);
    let key = voice.key();
    let object = file_object(&key, &m.id, "screen/video/000001.mp4", &video);
    assert_eq!(answered(&fake, Op::Complete, &object, None, 200), 1);
    let parts: Vec<u64> = fake
        .log()
        .iter()
        .filter(|l| l.op == Op::UploadPart && l.status == 200 && unprefixed(&l.key) == object)
        .map(|l| l.bytes)
        .collect();
    assert_eq!(parts.len(), 3);
    assert!(parts[..2].iter().all(|b| *b == 8 << 20), "{parts:?}");
    let stored = objects(&fake)
        .into_iter()
        .find(|(k, _)| *k == object)
        .unwrap();
    assert_eq!(decrypt(&key, &object, &stored.1), video);
}
