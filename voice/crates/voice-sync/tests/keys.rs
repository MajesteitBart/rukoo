//! The recovery code, the protectors and the key store.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use serde_json::Value;
use voice_sync::keys::{KeyStore, MasterKey, KEY_FILE, MASTER_KEY_FILE, SECRET_FILE};
use voice_sync::protect::{
    self, Protector, TestProtector, MASTER_KEY_LABEL, MASTER_KEY_MAGIC, SECRET_LABEL,
};
use voice_sync::{recovery, SyncError, SyncErrorKind, Zeroizing};

/// A folder of its own under the system's temp folder, removed on drop.
struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Scratch {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let path = std::env::temp_dir().join(format!(
            "voice-sync-keys-{name}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        Scratch(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn vectors() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/sync-vectors.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn vector_key() -> (MasterKey, String, String) {
    let v = vectors();
    let hex = v["masterKey"].as_str().unwrap();
    let bytes: Vec<u8> = (0..64)
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect();
    (
        MasterKey::from_bytes(bytes.try_into().unwrap()),
        v["kid"].as_str().unwrap().to_string(),
        v["recoveryCode"].as_str().unwrap().to_string(),
    )
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && haystack.windows(needle.len()).any(|w| w == needle)
}

#[test]
fn the_recovery_code_matches_the_vector() {
    let (key, kid, code) = vector_key();
    assert_eq!(recovery::encode(&key), code);
    assert_eq!(recovery::decode(&code).unwrap().kid(), kid);
}

#[test]
fn recovery_codes_round_trip() {
    for _ in 0..50 {
        let key = MasterKey::generate().unwrap();
        let code = recovery::encode(&key);
        assert_eq!(code.len(), 4 + 11 * 6);
        assert!(code
            .bytes()
            .all(|b| b == b'-' || b"0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(&b)));
        assert_eq!(recovery::decode(&code).unwrap().kid(), key.kid());
    }
}

#[test]
fn decoding_forgives_case_spaces_and_lookalikes() {
    let (_, kid, code) = vector_key();
    let lower = code.to_lowercase();
    let spaced = code.replace('-', " ");
    let bare = code.replace('-', "");
    let without_prefix = code.trim_start_matches("RKV1-").to_string();
    let padded = format!("  {code}\n");
    // The vector's code has both 1 and 0 in it, so these swaps change it.
    let body = code.trim_start_matches("RKV1-");
    assert!(body.contains('1') && body.contains('0'));
    let with_i = format!("RKV1-{}", body.replace('1', "I"));
    let with_l = format!("rkv1 {}", body.replace('1', "l"));
    let with_o = format!("RKV1-{}", body.replace('0', "o"));
    for input in [
        lower,
        spaced,
        bare,
        without_prefix,
        padded,
        with_i,
        with_l,
        with_o,
    ] {
        assert_eq!(recovery::decode(&input).unwrap().kid(), kid, "{input:?}");
    }
}

#[test]
fn decoding_refuses_what_isnt_a_key() {
    let (_, _, code) = vector_key();
    let body: Vec<char> = code.trim_start_matches("RKV1-").chars().collect();

    // One symbol changed: the key changes and the check digits no longer match.
    let mut typo = body.clone();
    typo[0] = if typo[0] == 'A' { 'B' } else { 'A' };
    let typo: String = typo.into_iter().collect();
    let error = recovery::decode(&format!("RKV1-{typo}")).unwrap_err();
    assert_eq!(error.kind, SyncErrorKind::Key);
    assert!(error.message.contains("typo"), "{}", error.message);

    // Two neighbouring symbols swapped.
    let mut swapped = body.clone();
    let i = (0..body.len() - 1)
        .find(|&i| body[i] != body[i + 1])
        .unwrap();
    swapped.swap(i, i + 1);
    let swapped: String = swapped.into_iter().collect();
    assert!(recovery::decode(&swapped).is_err());

    let short: String = body[..54].iter().collect();
    let long = format!("{}0", body.iter().collect::<String>());
    let with_u = format!("U{}", body[1..].iter().collect::<String>());
    let wrong_prefix = format!("RKV2-{}", body.iter().collect::<String>());
    for input in [
        "",
        "RKV1-",
        short.as_str(),
        long.as_str(),
        with_u.as_str(),
        wrong_prefix.as_str(),
        "RKV1-ÄÄÄÄÄ",
    ] {
        let error = recovery::decode(input).expect_err(input);
        assert_eq!(error.kind, SyncErrorKind::Key, "{input:?}");
    }
}

#[test]
fn the_master_key_shows_only_its_kid() {
    let key = MasterKey::from_bytes([0x42; 32]);
    let debug = format!("{key:?}");
    assert_eq!(debug, format!("MasterKey({:?})", key.kid()));
    assert!(!debug.contains("42, 42"));
    assert_eq!(key.kid().len(), 16);
    assert_ne!(
        MasterKey::generate().unwrap().kid(),
        MasterKey::generate().unwrap().kid()
    );
}

#[test]
fn the_test_protector_round_trips() -> Result<(), SyncError> {
    let p = TestProtector;
    let blob = p.protect(b"the bucket secret", SECRET_LABEL)?;
    assert!(!contains(&blob, b"the bucket secret"));
    // The type is part of the contract: a change of type fails to compile.
    let plain: Zeroizing<Vec<u8>> = p.unprotect(&blob, SECRET_LABEL)?;
    assert_eq!(&plain[..], b"the bucket secret");
    let error = p.unprotect(&blob, MASTER_KEY_LABEL).unwrap_err();
    assert_eq!(error.kind, SyncErrorKind::Key);
    Ok(())
}

#[test]
fn the_key_store_keeps_the_key_and_the_secret_protected() -> Result<(), SyncError> {
    let dir = Scratch::new("store");
    let store = KeyStore::new(dir.path(), Arc::new(TestProtector));
    assert!(store.load()?.is_none());
    assert!(store.info().is_none());
    let none: Option<Zeroizing<String>> = store.secret()?;
    assert!(none.is_none());
    assert_eq!(store.mark_exported(5).unwrap_err().kind, SyncErrorKind::Key);

    let key = store.create(1_000)?;
    let info = store.info().unwrap();
    assert_eq!(info.kid, key.kid());
    assert_eq!(info.created_at, 1_000);
    assert_eq!(info.exported_at, None);
    assert_eq!(store.load()?.unwrap().kid(), key.kid());
    // A second key would orphan what the first one encrypted.
    assert!(store.create(2_000).is_err());
    assert_eq!(store.load()?.unwrap().kid(), key.kid());

    store.mark_exported(1_500)?;
    assert_eq!(store.info().unwrap().exported_at, Some(1_500));

    store.save_secret("s3cr3t-value")?;
    let secret: Option<Zeroizing<String>> = store.secret()?;
    assert_eq!(secret.as_deref().map(String::as_str), Some("s3cr3t-value"));

    // Nothing on disk holds the key or the secret in plain text.
    let master = std::fs::read(dir.path().join(MASTER_KEY_FILE)).unwrap();
    let secret_file = std::fs::read(dir.path().join(SECRET_FILE)).unwrap();
    let key_json = std::fs::read_to_string(dir.path().join(KEY_FILE)).unwrap();
    assert!(master.starts_with(b"RKVK\x01"));
    assert!(secret_file.starts_with(b"RKVS\x01"));
    assert!(!contains(&secret_file, b"s3cr3t-value"));
    let code = recovery::encode(&key);
    for file in [&master, &secret_file, &key_json.as_bytes().to_vec()] {
        assert!(!contains(file, code.as_bytes()));
    }
    let parsed: Value = serde_json::from_str(&key_json).unwrap();
    assert_eq!(parsed["kid"], key.kid());
    assert_eq!(parsed["createdAt"], 1_000);
    assert_eq!(parsed["exportedAt"], 1_500);
    assert_eq!(parsed.as_object().unwrap().len(), 3);
    // No temporary files are left.
    let mut names: Vec<String> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert_eq!(names, [SECRET_FILE, KEY_FILE, MASTER_KEY_FILE]);

    // Another key from a recovery code replaces this one; whoever typed it has it saved.
    let other = MasterKey::generate()?;
    store.replace(&other, 3_000)?;
    assert_eq!(store.load()?.unwrap().kid(), other.kid());
    let info = store.info().unwrap();
    assert_eq!((info.created_at, info.exported_at), (3_000, Some(3_000)));

    store.remove_secret()?;
    assert!(store.secret()?.is_none());
    store.remove_secret()?;
    Ok(())
}

#[test]
fn loading_restores_a_key_json_a_crash_left_out() -> Result<(), SyncError> {
    let dir = Scratch::new("heal");
    let store = KeyStore::new(dir.path(), Arc::new(TestProtector));
    let key = store.create(1_000)?;
    store.mark_exported(2_000)?;

    // A crash right after master-key.bin was written: no key.json.
    std::fs::remove_file(dir.path().join(KEY_FILE)).unwrap();
    assert!(store.info().is_none());
    assert_eq!(store.load()?.unwrap().kid(), key.kid());
    let info = store.info().unwrap();
    assert_eq!(info.kid, key.kid());
    assert_eq!(info.exported_at, None, "not saved until the user says so");
    assert!(info.created_at > 1_700_000_000_000);
    store.mark_exported(3_000)?;

    // A crash during replace: the new key, the old key.json.
    let other = MasterKey::generate()?;
    protect::write_protected(
        &dir.path().join(MASTER_KEY_FILE),
        MASTER_KEY_MAGIC,
        MASTER_KEY_LABEL,
        &raw_key(&other),
        &TestProtector,
    )?;
    assert_eq!(store.info().unwrap().kid, key.kid());
    assert_eq!(store.load()?.unwrap().kid(), other.kid());
    assert_eq!(store.info().unwrap().kid, other.kid());
    assert_eq!(store.info().unwrap().exported_at, None);
    Ok(())
}

/// The raw key bytes, read back from a key store of their own.
fn raw_key(key: &MasterKey) -> Vec<u8> {
    let dir = Scratch::new("raw");
    let store = KeyStore::new(dir.path(), Arc::new(TestProtector));
    store.replace(key, 0).unwrap();
    let file = std::fs::read(dir.path().join(MASTER_KEY_FILE)).unwrap();
    TestProtector
        .unprotect(&file[5..], MASTER_KEY_LABEL)
        .unwrap()
        .to_vec()
}

#[test]
fn damaged_files_are_refused() -> Result<(), SyncError> {
    let dir = Scratch::new("damaged");
    let store = KeyStore::new(dir.path(), Arc::new(TestProtector));
    store.create(1)?;
    store.save_secret("secret")?;

    let master = dir.path().join(MASTER_KEY_FILE);
    let mut bytes = std::fs::read(&master).unwrap();
    let last = bytes.len() - 1;
    bytes[last] ^= 1;
    std::fs::write(&master, &bytes).unwrap();
    assert_eq!(store.load().unwrap_err().kind, SyncErrorKind::Key);
    std::fs::write(&master, b"RKVS\x01whatever").unwrap();
    assert_eq!(store.load().unwrap_err().kind, SyncErrorKind::Key);
    std::fs::write(&master, b"RKVK\x02whatever").unwrap();
    assert_eq!(store.load().unwrap_err().kind, SyncErrorKind::Key);
    // A key of the wrong length is refused too.
    protect::write_protected(
        &master,
        MASTER_KEY_MAGIC,
        MASTER_KEY_LABEL,
        &[1; 16],
        &TestProtector,
    )?;
    assert_eq!(store.load().unwrap_err().kind, SyncErrorKind::Key);

    // A secret the protector can't open is one to save again.
    let secret = dir.path().join(SECRET_FILE);
    let mut bytes = std::fs::read(&secret).unwrap();
    bytes[7] ^= 1;
    std::fs::write(&secret, &bytes).unwrap();
    assert_eq!(store.secret().unwrap_err().kind, SyncErrorKind::NoSecret);
    assert!(store.save_secret("").is_err());
    Ok(())
}

#[test]
fn the_system_protector_matches_the_platform() {
    let p = protect::system();
    let result = p.protect(b"x", SECRET_LABEL);
    if cfg!(windows) {
        assert!(result.is_ok());
    } else {
        assert_eq!(result.unwrap_err().message, "Bucket sync needs Windows.");
    }
}

#[cfg(windows)]
mod dpapi {
    use super::*;
    use voice_sync::protect::Dpapi;

    #[test]
    fn dpapi_round_trips() -> Result<(), SyncError> {
        let blob = Dpapi.protect(b"a secret for dpapi", SECRET_LABEL)?;
        let plain: Zeroizing<Vec<u8>> = Dpapi.unprotect(&blob, SECRET_LABEL)?;
        assert_eq!(&plain[..], b"a secret for dpapi");
        Ok(())
    }

    #[test]
    fn a_dpapi_blob_doesnt_contain_the_plaintext() -> Result<(), SyncError> {
        let blob = Dpapi.protect(b"a secret for dpapi", SECRET_LABEL)?;
        assert!(!contains(&blob, b"a secret for dpapi"));
        assert!(blob.len() > 18);
        Ok(())
    }

    #[test]
    fn dpapi_refuses_the_wrong_label_and_a_changed_blob() -> Result<(), SyncError> {
        let blob = Dpapi.protect(b"a secret for dpapi", SECRET_LABEL)?;
        let error = Dpapi.unprotect(&blob, MASTER_KEY_LABEL).unwrap_err();
        assert_eq!(error.kind, SyncErrorKind::Key);
        let mut changed = blob.clone();
        let last = changed.len() - 1;
        changed[last] ^= 1;
        assert_eq!(
            Dpapi.unprotect(&changed, SECRET_LABEL).unwrap_err().kind,
            SyncErrorKind::Key
        );
        Ok(())
    }

    #[test]
    fn the_key_store_works_with_dpapi() -> Result<(), SyncError> {
        let dir = Scratch::new("dpapi");
        let store = KeyStore::new(dir.path(), Arc::new(Dpapi));
        let key = store.create(7)?;
        assert_eq!(store.load()?.unwrap().kid(), key.kid());
        store.save_secret("dpapi-secret")?;
        assert_eq!(
            store.secret()?.as_deref().map(String::as_str),
            Some("dpapi-secret")
        );
        let file = std::fs::read(dir.path().join(SECRET_FILE)).unwrap();
        assert!(!contains(&file, b"dpapi-secret"));
        // The test protector can't open what DPAPI wrote, as another user couldn't.
        let other = KeyStore::new(dir.path(), Arc::new(TestProtector));
        assert_eq!(other.load().unwrap_err().kind, SyncErrorKind::Key);
        assert_eq!(other.secret().unwrap_err().kind, SyncErrorKind::NoSecret);
        Ok(())
    }
}
