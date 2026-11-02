//! `rukoo-voice-fake-s3 --port <p> --bucket <name> --access-key <id> --dir <folder>`: the fake S3
//! for the live paired run. Prints `listening http://127.0.0.1:<port>` once it listens and serves
//! until it is stopped.
//!
//! The folder's layout is what `voice/scripts/live-meeting.mjs` and `check-encrypted.mjs` read:
//!
//! - `objects/<key>`: each stored object's raw bytes, the key's `/` as folders. Nothing else is in
//!   `objects/`, so every file there must start with `RKV1`.
//! - `uploads/`: the parts of multipart uploads that haven't completed.
//! - `log.jsonl`: one line per answered request, [`voice_s3_fake::Logged`] as
//!   `{ "op", "key", "part", "bytes", "status", "at" }` with `op` in lowercase snake case
//!   (`put`, `upload_part`, …). A restart on the same folder appends.

use std::path::PathBuf;
use std::process::ExitCode;

use voice_s3_fake::FakeS3;

const USAGE: &str =
    "usage: rukoo-voice-fake-s3 --port <p> --bucket <name> --access-key <id> --dir <folder>";

fn main() -> ExitCode {
    let mut port = None;
    let mut bucket = None;
    let mut access_key = None;
    let mut dir = None;
    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        let Some(value) = args.next() else {
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        };
        match flag.as_str() {
            "--port" => port = value.parse::<u16>().ok(),
            "--bucket" => bucket = Some(value),
            "--access-key" => access_key = Some(value),
            "--dir" => dir = Some(PathBuf::from(value)),
            _ => {
                eprintln!("{USAGE}");
                return ExitCode::from(2);
            }
        }
    }
    let (Some(port), Some(bucket), Some(access_key), Some(dir)) = (port, bucket, access_key, dir)
    else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    let fake = match FakeS3::start_on(port, &bucket, &access_key, Some(dir)) {
        Ok(fake) => fake,
        Err(e) => {
            eprintln!("rukoo-voice-fake-s3: {e}");
            return ExitCode::FAILURE;
        }
    };
    println!("listening {}", fake.endpoint());
    loop {
        std::thread::park();
    }
}
