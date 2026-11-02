//! The `RKV1` format and the object names against `voice/fixtures/sync-vectors.json`, which an
//! implementation independent of this crate produced, and against damage of every kind.

use std::io::Cursor;
use std::time::Instant;

use serde_json::Value;
use sha2::{Digest, Sha256};
use voice_sync::format::{self, cipher_len, cipher_range, Header, Sealer, CHUNK, HEADER_LEN, TAG};
use voice_sync::keys::MasterKey;
use voice_sync::names::{self, hex};
use voice_sync::SyncErrorKind;

const CIPHER_CHUNK: u64 = CHUNK + TAG;

fn vectors() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/sync-vectors.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("sync-vectors.json"))
        .expect("valid JSON")
}

fn unhex(text: &str) -> Vec<u8> {
    assert!(text.len() % 2 == 0, "odd hex");
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("hex"))
        .collect()
}

fn array<const N: usize>(text: &str) -> [u8; N] {
    unhex(text).try_into().expect("length")
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key]
        .as_str()
        .unwrap_or_else(|| panic!("{key} is text"))
}

fn plain(len: u64) -> Vec<u8> {
    (0..len).map(|i| (i % 251) as u8).collect()
}

fn master(v: &Value) -> MasterKey {
    MasterKey::from_bytes(array(text(v, "masterKey")))
}

/// A whole object: its header and every ciphertext byte.
fn seal_all(sealer: &Sealer, header: &Header, data: &[u8]) -> Vec<u8> {
    let total = cipher_len(data.len() as u64);
    sealer
        .read_cipher(header, &mut Cursor::new(data), 0, total as usize)
        .expect("seal")
}

/// The 200,000-byte vector object, sealed with the vectors' material.
fn sample() -> (MasterKey, String, Header, Sealer, Vec<u8>, Vec<u8>) {
    let v = vectors();
    let key = master(&v);
    let entry = v["objects"]
        .as_array()
        .unwrap()
        .iter()
        .find(|o| o["plainLen"] == 200_000)
        .expect("a 200,000-byte vector")
        .clone();
    let object = text(&entry, "object").to_string();
    let m = &v["material"];
    let data = plain(200_000);
    let (header, sealer) = Sealer::with_material(
        &key,
        &object,
        200_000,
        array(text(m, "dek")),
        array(text(m, "prefix")),
        array(text(m, "wrapNonce")),
    );
    let bytes = seal_all(&sealer, &header, &data);
    (key, object, header, sealer, data, bytes)
}

#[test]
fn derivations_match_the_vectors() {
    let v = vectors();
    let key = master(&v);
    assert_eq!(key.kid(), text(&v, "kid"));
    assert_eq!(hex(&key.name_key()), text(&v, "nameKey"));
    assert_eq!(hex(&key.wrap_key()), text(&v, "wrapKey"));
    assert_eq!(
        format!("{key:?}"),
        format!("MasterKey({:?})", text(&v, "kid"))
    );

    let name_key = key.name_key();
    let meeting = text(&v, "meeting");
    let m = names::meeting_hash(&name_key, meeting);
    assert_eq!(m, text(&v, "meetingHash"));
    assert_eq!(
        names::manifest_object(&key.kid(), &m),
        text(&v, "manifestObject")
    );
    for file in v["files"].as_array().unwrap() {
        assert_eq!(
            names::file_object(
                &key.kid(),
                &m,
                &name_key,
                meeting,
                text(file, "path"),
                text(file, "sha256")
            ),
            text(file, "object")
        );
    }
    assert_eq!(
        names::index_object(&key.kid(), &name_key, text(&v, "writer")),
        text(&v, "indexObject")
    );
    assert_eq!(names::index_prefix(&key.kid()), text(&v, "indexPrefix"));
    for object in v["objects"].as_array().unwrap() {
        let data = plain(object["plainLen"].as_u64().unwrap());
        assert_eq!(names::sha256_hex(&data), text(object, "plainSha256"));
        assert_eq!(
            names::file_object(
                &key.kid(),
                &m,
                &name_key,
                meeting,
                text(object, "path"),
                text(object, "plainSha256")
            ),
            text(object, "object")
        );
    }
}

#[test]
fn objects_match_the_vectors() {
    let v = vectors();
    let key = master(&v);
    let m = &v["material"];
    let objects = v["objects"].as_array().unwrap();
    assert_eq!(objects.len(), 6);
    for entry in objects {
        let len = entry["plainLen"].as_u64().unwrap();
        let object = text(entry, "object");
        let data = plain(len);
        let (header, sealer) = Sealer::with_material(
            &key,
            object,
            len,
            array(text(m, "dek")),
            array(text(m, "prefix")),
            array(text(m, "wrapNonce")),
        );
        assert_eq!(hex(&header.to_bytes()), text(entry, "header"), "{len}");
        assert_eq!(header.kid_hex(), key.kid());
        assert_eq!(header.plain_len(), len);

        let bytes = seal_all(&sealer, &header, &data);
        assert_eq!(bytes.len() as u64, entry["cipherLen"].as_u64().unwrap());
        assert_eq!(bytes.len() as u64, cipher_len(len));
        assert_eq!(
            hex(&Sha256::digest(&bytes)),
            text(entry, "cipherSha256"),
            "{len}"
        );

        let parsed = Header::parse(&bytes).unwrap();
        assert_eq!(parsed, header);
        assert_eq!(Header::parse(&header.to_bytes()).unwrap(), header);
        assert_eq!(format::open_object(&key, object, &bytes).unwrap(), data);

        // A retry from the stored header encrypts to the same bytes.
        let again = Sealer::open(&key, object, &parsed).unwrap();
        assert_eq!(seal_all(&again, &parsed, &data), bytes);
    }
}

#[test]
fn a_flipped_byte_in_any_region_fails() {
    let (key, object, _, _, data, bytes) = sample();
    assert_eq!(format::open_object(&key, &object, &bytes).unwrap(), data);
    let last = bytes.len() - 1;
    let regions: [(&str, usize, SyncErrorKind); 13] = [
        ("magic", 0, SyncErrorKind::Crypto),
        ("version", 4, SyncErrorKind::Crypto),
        ("algorithm", 5, SyncErrorKind::Crypto),
        ("chunk size", 6, SyncErrorKind::Crypto),
        ("kid", 10, SyncErrorKind::Key),
        ("length", 20, SyncErrorKind::Crypto),
        ("stream prefix", 30, SyncErrorKind::Crypto),
        ("wrap nonce", 50, SyncErrorKind::Crypto),
        ("wrapped key", 80, SyncErrorKind::Crypto),
        ("wrapped key's tag", 110, SyncErrorKind::Crypto),
        ("a chunk", HEADER_LEN as usize + 1000, SyncErrorKind::Crypto),
        (
            "a chunk's tag",
            HEADER_LEN as usize + CHUNK as usize + 3,
            SyncErrorKind::Crypto,
        ),
        ("the last tag", last, SyncErrorKind::Crypto),
    ];
    for (region, at, kind) in regions {
        let mut damaged = bytes.clone();
        damaged[at] ^= 0x01;
        let error = format::open_object(&key, &object, &damaged)
            .expect_err(&format!("a flipped byte in {region} must fail"));
        assert_eq!(error.kind, kind, "{region}");
    }
}

#[test]
fn a_ciphertext_one_chunk_short_fails() {
    let (key, object, header, _, _, bytes) = sample();
    // 200,000 bytes are four chunks; drop the last.
    let short = &bytes[..(HEADER_LEN + 3 * CIPHER_CHUNK) as usize];
    assert!(format::open_object(&key, &object, short).is_err());
    let mut long = bytes.clone();
    long.push(0);
    assert!(format::open_object(&key, &object, &long).is_err());

    // The last-chunk flag on its own: the same DEK and prefix, but a header that says the object
    // ends after three full chunks. Chunk 2 was sealed as a middle chunk, so taking it as the
    // last fails, while chunk 2 sealed as the last one opens.
    let v = vectors();
    let m = &v["material"];
    let (short_header, short_sealer) = Sealer::with_material(
        &key,
        &object,
        3 * CHUNK,
        array(text(m, "dek")),
        array(text(m, "prefix")),
        array(text(m, "wrapNonce")),
    );
    let chunk = |all: &[u8], i: u64| {
        let from = (HEADER_LEN + i * CIPHER_CHUNK) as usize;
        all[from..from + CIPHER_CHUNK as usize].to_vec()
    };
    let middle = chunk(&bytes, 2);
    let error = short_sealer
        .open_chunk(&short_header, 2, &middle)
        .expect_err("a middle chunk taken for the last must fail");
    assert_eq!(error.kind, SyncErrorKind::Crypto);
    let short_bytes = seal_all(&short_sealer, &short_header, &plain(3 * CHUNK));
    let own_last = chunk(&short_bytes, 2);
    assert_eq!(
        short_sealer
            .open_chunk(&short_header, 2, &own_last)
            .unwrap(),
        plain(200_000)[2 * CHUNK as usize..3 * CHUNK as usize]
    );
    // And the full header refuses the last chunk of the short object at position 2.
    let full = Sealer::open(&key, &object, &header).unwrap();
    assert!(full.open_chunk(&header, 2, &own_last).is_err());
}

#[test]
fn swapped_chunks_fail() {
    let (key, object, header, sealer, data, bytes) = sample();
    let a = (HEADER_LEN as usize, (HEADER_LEN + CIPHER_CHUNK) as usize);
    let b = (a.1, a.1 + CIPHER_CHUNK as usize);
    let mut swapped = bytes.clone();
    swapped[a.0..a.1].copy_from_slice(&bytes[b.0..b.1]);
    swapped[b.0..b.1].copy_from_slice(&bytes[a.0..a.1]);
    assert!(format::open_object(&key, &object, &swapped).is_err());
    // Each chunk still opens at its own position.
    assert_eq!(
        sealer.open_chunk(&header, 1, &bytes[b.0..b.1]).unwrap(),
        data[CHUNK as usize..2 * CHUNK as usize]
    );
    assert!(sealer.open_chunk(&header, 0, &bytes[b.0..b.1]).is_err());
    assert!(sealer.open_chunk(&header, 9, &bytes[b.0..b.1]).is_err());
    assert!(sealer.open_chunk(&header, 1, &bytes[b.0..b.1 - 1]).is_err());
}

#[test]
fn another_object_name_or_key_fails() {
    let (key, object, header, _, _, bytes) = sample();
    let renamed = object.replace("/o/", "/o/0");
    let error = format::open_object(&key, &renamed, &bytes).unwrap_err();
    assert_eq!(error.kind, SyncErrorKind::Crypto);
    assert!(Sealer::open(&key, &renamed, &header).is_err());

    let other = MasterKey::from_bytes([9; 32]);
    let error = format::open_object(&other, &object, &bytes).unwrap_err();
    assert_eq!(error.kind, SyncErrorKind::Key);
}

#[test]
fn cipher_range_covers_whole_chunks() {
    let len = 200_000;
    let end = cipher_len(len);
    let chunk = |i: u64| HEADER_LEN + i * CIPHER_CHUNK;
    assert_eq!(cipher_range(len, 0, 1), (chunk(0), chunk(1)));
    assert_eq!(cipher_range(len, 0, 65_535), (chunk(0), chunk(1)));
    assert_eq!(cipher_range(len, 65_535, 65_536), (chunk(0), chunk(1)));
    assert_eq!(cipher_range(len, 65_535, 65_537), (chunk(0), chunk(2)));
    assert_eq!(cipher_range(len, 65_536, 65_537), (chunk(1), chunk(2)));
    assert_eq!(cipher_range(len, 199_999, 200_000), (chunk(3), end));
    assert_eq!(cipher_range(len, 0, len), (chunk(0), end));
    assert_eq!(cipher_range(len, 150_000, 999_999), (chunk(2), end));
    assert_eq!(
        cipher_range(65_536, 0, 65_536),
        (chunk(0), cipher_len(65_536))
    );
    assert_eq!(cipher_range(1, 0, 1), (HEADER_LEN, cipher_len(1)));

    // The plaintext of any range comes back from the chunks the range names.
    let (_, _, header, sealer, data, bytes) = sample();
    for (a, b) in [
        (0, 1),
        (65_535, 65_537),
        (100_000, 140_000),
        (199_999, 200_000),
    ] {
        let (from, to) = cipher_range(len, a, b);
        let first = (from - HEADER_LEN) / CIPHER_CHUNK;
        let mut out = Vec::new();
        let mut at = from;
        let mut index = first;
        while at < to {
            let next = (at + CIPHER_CHUNK).min(to);
            out.extend(
                sealer
                    .open_chunk(&header, index, &bytes[at as usize..next as usize])
                    .unwrap(),
            );
            at = next;
            index += 1;
        }
        let skip = (a - first * CHUNK) as usize;
        assert_eq!(
            &out[skip..skip + (b - a) as usize],
            &data[a as usize..b as usize]
        );
    }
}

#[test]
fn any_slice_from_read_cipher_equals_that_slice_of_the_whole_object() {
    let (_, _, header, sealer, data, bytes) = sample();
    let total = bytes.len() as u64;
    let cases: &[(u64, usize)] = &[
        (0, 0),
        (0, 1),
        (0, 115),
        (0, 116),
        (114, 2),
        (100, 70_000),
        (115, 65_552),
        (115 + 65_551, 2),
        (115 + 65_552 * 2 - 7, 65_552 + 14),
        (115 + 3 * 65_552, 10_000),
        (total - 1, 1),
        (total - 10, 100),
        (total, 5),
        (total + 100, 5),
        (0, total as usize),
        (1, total as usize),
    ];
    for &(offset, len) in cases {
        let slice = sealer
            .read_cipher(&header, &mut Cursor::new(&data), offset, len)
            .unwrap();
        let from = offset.min(total) as usize;
        let to = (offset + len as u64).min(total) as usize;
        assert_eq!(slice, bytes[from..to], "offset {offset} len {len}");
    }
}

#[test]
fn a_file_shorter_than_its_header_is_refused() {
    let key = MasterKey::from_bytes([3; 32]);
    let (header, sealer) = Sealer::new(&key, "rkv1/x/m/y/o/z", 100_000).unwrap();
    let short = plain(70_000);
    let error = sealer
        .read_cipher(&header, &mut Cursor::new(&short), 0, 200_000)
        .unwrap_err();
    assert_eq!(error.kind, SyncErrorKind::Local);
    // The chunks the file still holds are fine.
    assert!(sealer
        .read_cipher(&header, &mut Cursor::new(&short), 0, 1000)
        .is_ok());
}

#[test]
fn new_objects_get_fresh_material() {
    let key = MasterKey::generate().unwrap();
    let data = plain(70_000);
    let (h1, s1) = Sealer::new(&key, "rkv1/a", data.len() as u64).unwrap();
    let (h2, s2) = Sealer::new(&key, "rkv1/a", data.len() as u64).unwrap();
    assert_ne!(h1.to_bytes(), h2.to_bytes());
    assert_eq!(h1.to_bytes()[..24], h2.to_bytes()[..24]);
    let b1 = seal_all(&s1, &h1, &data);
    let b2 = seal_all(&s2, &h2, &data);
    assert_ne!(b1[HEADER_LEN as usize..], b2[HEADER_LEN as usize..]);
    assert_eq!(format::open_object(&key, "rkv1/a", &b1).unwrap(), data);
    assert_eq!(format::open_object(&key, "rkv1/a", &b2).unwrap(), data);
}

#[test]
fn headers_refuse_what_they_dont_know() {
    let (_, _, header, _, _, _) = sample();
    let bytes = header.to_bytes();
    assert!(Header::parse(&bytes[..114]).is_err());
    let mut reserved = bytes;
    reserved[7] = 1;
    assert!(Header::parse(&reserved).is_err());
    let mut huge = bytes;
    huge[16..24].copy_from_slice(&u64::MAX.to_be_bytes());
    assert!(Header::parse(&huge).is_err());
}

/// Measurement M4 of the spec: `cargo test -p voice-sync --release --test format -- --ignored
/// --nocapture encryption_speed`.
#[test]
#[ignore]
fn encryption_speed() {
    const LEN: u64 = 256 << 20;
    const STEP: usize = 8 << 20;
    let key = MasterKey::generate().unwrap();
    let data = vec![0x5au8; LEN as usize];
    let (header, sealer) = Sealer::new(&key, "rkv1/speed", LEN).unwrap();
    let total = cipher_len(LEN);
    let started = Instant::now();
    let mut cipher = Vec::with_capacity(total as usize);
    let mut source = Cursor::new(&data);
    while (cipher.len() as u64) < total {
        let part = sealer
            .read_cipher(&header, &mut source, cipher.len() as u64, STEP)
            .unwrap();
        cipher.extend_from_slice(&part);
    }
    let sealed = started.elapsed();
    let started = Instant::now();
    let opened = format::open_object(&key, "rkv1/speed", &cipher).unwrap();
    let open = started.elapsed();
    assert_eq!(opened.len() as u64, LEN);
    let mb = LEN as f64 / 1e6;
    println!(
        "sealed {mb:.0} MB in {:.2} s ({:.0} MB/s), opened in {:.2} s ({:.0} MB/s)",
        sealed.as_secs_f64(),
        mb / sealed.as_secs_f64(),
        open.as_secs_f64(),
        mb / open.as_secs_f64()
    );
}
