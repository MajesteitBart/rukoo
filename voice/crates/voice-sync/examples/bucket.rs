//! The bucket side of the by-hand check against a real S3 bucket (spec RUK-110 6.4 item 1), with
//! the S3 client Voice itself uses. `voice/scripts/bucket-check.mjs` runs it.
//!
//!   cargo run -p voice-sync --example bucket -- list
//!   cargo run -p voice-sync --example bucket -- dump <folder>
//!   cargo run -p voice-sync --example bucket -- empty
//!   cargo run -p voice-sync --example bucket -- probe
//!   cargo run -p voice-sync --example bucket -- multipart
//!
//! `list` prints `{"objects": n, "bytes": n}` for the folder; `dump` writes every object's raw bytes
//! to `<folder>/<key>`, the key without the folder, which is the layout check-encrypted.mjs reads;
//! `empty` deletes every object in the folder and prints how many went. `probe` runs Test
//! connection's probe and prints `{"otherKeys": n}`. `multipart` uploads 20 MiB of pseudo-random
//! bytes in three parts of 8, 8 and 4 MiB, checks them with ListParts, completes the upload, reads
//! the object back, compares it and deletes it.
//!
//! The bucket comes from `RUKOO_VOICE_SYNC_TEST_ENDPOINT`, `_REGION`, `_BUCKET`, `_ACCESS_KEY_ID`
//! and `_SECRET_ACCESS_KEY`, the folder from `_PREFIX` (required, so a run never touches a whole
//! bucket) and the URL style Test connection chose from `_URL_STYLE` (`path` or `virtual`). None
//! of them is ever printed: an error prints only its code, because voice-sync's messages name the
//! endpoint's host.

use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::json;
use sha2::{Digest, Sha256};
use voice_sync::s3::{Bucket, Listing};
use voice_sync::SyncConfig;

const PART: usize = 8 << 20;

fn var(name: &str) -> String {
    std::env::var(format!("RUKOO_VOICE_SYNC_TEST_{name}")).unwrap_or_default()
}

fn fail(what: &str, code: &str) -> ! {
    eprintln!("bucket: {what} failed ({code})");
    std::process::exit(1);
}

fn list(bucket: &Bucket) -> Listing {
    bucket
        .list("", None)
        .unwrap_or_else(|e| fail("listing", e.code()))
}

/// Bytes nobody could mistake for media: an xorshift stream.
fn noise(len: usize, mut seed: u64) -> Vec<u8> {
    let mut out = Vec::with_capacity(len);
    while out.len() < len {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        out.extend_from_slice(&seed.to_le_bytes());
    }
    out.truncate(len);
    out
}

fn multipart(bucket: &Bucket) {
    let started = Instant::now();
    let seed = u64::from(std::process::id()) | 1 << 40;
    let body = noise(2 * PART + PART / 2, seed);
    let key = format!("multipart-check/{seed:016x}");
    let upload = bucket
        .create_multipart(&key)
        .unwrap_or_else(|e| fail("starting a multipart upload", e.code()));
    let mut etags = Vec::new();
    for (i, chunk) in body.chunks(PART).enumerate() {
        let number = u16::try_from(i + 1).expect("three parts");
        let etag = bucket
            .upload_part(&key, &upload, number, chunk)
            .unwrap_or_else(|e| fail("uploading a part", e.code()));
        etags.push(etag);
    }
    let parts = bucket
        .list_parts(&key, &upload)
        .unwrap_or_else(|e| fail("listing the parts", e.code()));
    let sizes: Vec<u64> = parts.iter().map(|p| p.size).collect();
    let listed_ok = parts.len() == etags.len()
        && parts
            .iter()
            .zip(&etags)
            .enumerate()
            .all(|(i, (p, etag))| usize::from(p.number) == i + 1 && &p.etag == etag);
    bucket
        .complete_multipart(&key, &upload, &etags)
        .unwrap_or_else(|e| fail("finishing the multipart upload", e.code()));
    let back = bucket
        .get(&key, None)
        .unwrap_or_else(|e| fail("reading the object back", e.code()));
    let same = Sha256::digest(&back) == Sha256::digest(&body);
    let size = bucket
        .head(&key)
        .unwrap_or_else(|e| fail("checking the object", e.code()));
    bucket
        .delete(&key)
        .unwrap_or_else(|e| fail("deleting the object", e.code()));
    println!(
        "{}",
        json!({
            "parts": etags.len(),
            "listedSizes": sizes,
            "listedMatch": listed_ok,
            "size": size,
            "same": same,
            "ms": started.elapsed().as_millis() as u64,
        })
    );
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let prefix = var("PREFIX");
    if prefix.trim().trim_matches('/').is_empty() {
        eprintln!("bucket: set RUKOO_VOICE_SYNC_TEST_PREFIX to the run's own folder");
        std::process::exit(2);
    }
    let cfg = SyncConfig::from_json(&json!({
        "service": "other",
        "endpoint": var("ENDPOINT"),
        "region": var("REGION"),
        "bucket": var("BUCKET"),
        "prefix": prefix,
        "accessKeyId": var("ACCESS_KEY_ID"),
        "urlStyle": var("URL_STYLE"),
    }))
    .unwrap_or_else(|e| fail("reading the bucket's settings", e.code()));
    let secret = var("SECRET_ACCESS_KEY");
    let bucket = Bucket::new(
        &cfg,
        &secret,
        Duration::from_secs(10),
        Duration::from_secs(120),
    )
    .unwrap_or_else(|e| fail("connecting", e.code()));
    match args.first().map(String::as_str) {
        Some("list") => {
            let listing = list(&bucket);
            let bytes: u64 = listing.keys.iter().map(|(_, size)| size).sum();
            println!(
                "{}",
                json!({ "objects": listing.keys.len(), "bytes": bytes })
            );
        }
        Some("dump") => {
            let Some(dir) = args.get(1) else {
                eprintln!("bucket: dump needs a folder");
                std::process::exit(2);
            };
            let listing = list(&bucket);
            let mut bytes = 0u64;
            for (key, _) in &listing.keys {
                // Keys are voice-sync's own `rkv1/<hex>/...`: no `..`, no drive.
                if key.split('/').any(|part| {
                    part.is_empty() || part == "." || part == ".." || part.contains(':')
                }) {
                    fail("checking a key", "failed");
                }
                let body = bucket
                    .get(key, None)
                    .unwrap_or_else(|e| fail("downloading", e.code()));
                let path = Path::new(dir).join(key);
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent).unwrap_or_else(|_| fail("writing", "local"));
                }
                std::fs::write(&path, &body).unwrap_or_else(|_| fail("writing", "local"));
                bytes += body.len() as u64;
            }
            println!(
                "{}",
                json!({ "objects": listing.keys.len(), "bytes": bytes })
            );
        }
        Some("empty") => {
            let keys: Vec<String> = list(&bucket).keys.into_iter().map(|(key, _)| key).collect();
            let failed = bucket
                .delete_many(&keys)
                .unwrap_or_else(|e| fail("deleting", e.code()));
            println!(
                "{}",
                json!({ "deleted": keys.len() - failed.len(), "failed": failed.len() })
            );
        }
        Some("probe") => {
            let others = bucket
                .probe(None)
                .unwrap_or_else(|e| fail("the probe", e.code()));
            println!("{}", json!({ "otherKeys": others }));
        }
        Some("multipart") => multipart(&bucket),
        _ => {
            eprintln!("bucket: list, dump <folder>, empty, probe or multipart");
            std::process::exit(2);
        }
    }
}
