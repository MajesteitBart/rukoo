//! The model registry: where models are found, verification and the stamp, the download into
//! Voice's own folder, removal, and the archive rules, all with small synthetic models.

mod support;

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::{Duration, SystemTime};

use sha2::{Digest, Sha256};
use support::{FakeServer, Reply, TempDir};
use voice_core::local::{
    extract, files_present, validate, Archive, Location, ModelErrorKind, ModelFile, ModelRegistry,
    ModelSpec, Progress, Stage, Verification,
};

const ROOT: &str = "model-root";
const FILES: [(&str, &[u8]); 3] = [
    ("encoder.int8.onnx", b"pretend this is a large encoder"),
    ("tokens.txt", b"<blk> 0\n\xe2\x96\x81the 1\n"),
    ("LICENSE-WEIGHTS", b"CC BY-SA 4.0"),
];

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn spec(archive: Option<(&str, &[u8])>) -> ModelSpec {
    ModelSpec {
        id: "orukeet-test".into(),
        label: "Orukeet test".into(),
        revision: "rev1".into(),
        folder: "orukeet".into(),
        settings_page: "Transcription".into(),
        custom_folder: true,
        archive: archive.map(|(url, bytes)| Archive {
            url: url.into(),
            size: bytes.len() as u64,
            sha256: sha256(bytes),
            root: ROOT.into(),
        }),
        files: FILES
            .iter()
            .map(|(name, bytes)| ModelFile {
                name: name.to_string(),
                size: bytes.len() as u64,
                sha256: sha256(bytes),
                url: None,
            })
            .collect(),
    }
}

fn install(dir: &Path) {
    fs::create_dir_all(dir).unwrap();
    for (name, bytes) in FILES {
        fs::write(dir.join(name), bytes).unwrap();
    }
}

fn listing(dir: &Path) -> Vec<(PathBuf, u64, SystemTime)> {
    let mut entries = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(next) = stack.pop() {
        for entry in fs::read_dir(&next).unwrap() {
            let entry = entry.unwrap();
            // DirEntry metadata on Windows comes from the parent's index, which NTFS updates
            // lazily for folders; read the entry itself.
            let meta = fs::metadata(entry.path()).unwrap();
            if meta.is_dir() {
                stack.push(entry.path());
            }
            entries.push((entry.path(), meta.len(), meta.modified().unwrap()));
        }
    }
    entries.sort();
    entries
}

fn set_modified(path: &Path, offset: Duration) {
    let file = fs::OpenOptions::new().write(true).open(path).unwrap();
    file.set_modified(SystemTime::now() + offset).unwrap();
}

/// A .tar.bz2 archive built from raw headers, so tests can write the hostile entries a normal
/// archive builder refuses to create.
struct RawArchive {
    builder: tar::Builder<bzip2::write::BzEncoder<Vec<u8>>>,
}

impl RawArchive {
    fn new() -> RawArchive {
        RawArchive {
            builder: tar::Builder::new(bzip2::write::BzEncoder::new(
                Vec::new(),
                bzip2::Compression::fast(),
            )),
        }
    }

    fn entry(mut self, name: &str, kind: tar::EntryType, data: &[u8], link: &str) -> RawArchive {
        let mut header = tar::Header::new_old();
        header.as_old_mut().name[..name.len()].copy_from_slice(name.as_bytes());
        header.as_old_mut().linkname[..link.len()].copy_from_slice(link.as_bytes());
        header.set_entry_type(kind);
        header.set_size(data.len() as u64);
        header.set_mode(0o644);
        header.set_mtime(0);
        header.set_cksum();
        self.builder.append(&header, data).unwrap();
        self
    }

    fn file(self, name: &str, data: &[u8]) -> RawArchive {
        self.entry(name, tar::EntryType::Regular, data, "")
    }

    fn dir(self, name: &str) -> RawArchive {
        self.entry(name, tar::EntryType::Directory, b"", "")
    }

    fn model(mut self) -> RawArchive {
        self = self.dir(&format!("{ROOT}/"));
        for (name, bytes) in FILES {
            self = self.file(&format!("{ROOT}/{name}"), bytes);
        }
        self
    }

    fn finish(self) -> Vec<u8> {
        let mut encoder = self.builder.into_inner().unwrap();
        encoder.flush().unwrap();
        encoder.finish().unwrap()
    }
}

#[test]
fn pinned_catalog() {
    let orukeet = ModelSpec::orukeet();
    assert_eq!(orukeet.id, "orukeet-onnx-int8");
    assert_eq!(orukeet.revision, "55a984d46f68323301837194ce647c702f55facc");
    assert_eq!(orukeet.files.len(), 7);
    assert_eq!(orukeet.extracted_size(), 671_619_800);
    let archive = orukeet.archive.as_ref().unwrap();
    assert_eq!(archive.size, 486_807_585);
    assert_eq!(
        archive.sha256,
        "f9191f30178cc9122ce2f023bf9fefafc822028307b0efa4caff645ba3fe8d0a"
    );
    assert_eq!(archive.root, "sherpa-onnx-orukeet-v0.1.0-int8");
    assert!(archive
        .url
        .contains("/resolve/55a984d46f68323301837194ce647c702f55facc/onnx/"));
    assert_eq!(
        orukeet.install_dir(Path::new("models")),
        Path::new("models")
            .join("orukeet")
            .join("55a984d46f68323301837194ce647c702f55facc")
    );
    let nemotron = ModelSpec::nemotron();
    assert_eq!(nemotron.extracted_size(), 107_012_128);
    assert!(!nemotron.custom_folder);
}

#[test]
fn locate_prefers_the_chosen_folder_then_ownkey_then_voice() {
    let temp = TempDir::new("locate");
    let spec = spec(None);
    let ownkey_root = temp.join("ownkey-models");
    let custom = temp.join("chosen");
    let registry = ModelRegistry::new(temp.join("data"))
        .with_ownkey_models(Some(ownkey_root.clone()))
        .with_custom_dir(Some(custom.clone()));
    assert_eq!(registry.locate(&spec), None);

    install(&registry.own_dir(&spec));
    assert_eq!(registry.locate(&spec).unwrap().location, Location::Voice);
    install(&spec.install_dir(&ownkey_root));
    let found = registry.locate(&spec).unwrap();
    assert_eq!(found.location, Location::Ownkey);
    assert_eq!(found.dir, ownkey_root.join("orukeet").join("rev1"));
    assert!(!found.removable());
    // A chosen folder without the files falls through to the others.
    fs::create_dir_all(&custom).unwrap();
    assert_eq!(registry.locate(&spec).unwrap().location, Location::Ownkey);
    install(&custom);
    assert_eq!(registry.locate(&spec).unwrap().location, Location::Custom);
}

#[test]
fn presence_needs_every_file_at_its_pinned_size() {
    let temp = TempDir::new("present");
    let spec = spec(None);
    let dir = temp.join("m");
    install(&dir);
    assert!(files_present(&spec, &dir));
    fs::write(dir.join("tokens.txt"), b"short").unwrap();
    assert!(!files_present(&spec, &dir));
    fs::remove_file(dir.join("tokens.txt")).unwrap();
    assert!(!files_present(&spec, &dir));
}

#[test]
fn validation_messages() {
    let temp = TempDir::new("validate");
    let spec = spec(None);
    let dir = temp.join("m");
    install(&dir);
    let cancel = AtomicBool::new(false);
    validate(&spec, &dir, &cancel).unwrap();
    // Same size, other bytes.
    fs::write(dir.join("LICENSE-WEIGHTS"), b"CC BY-SA 9.9").unwrap();
    let damaged = validate(&spec, &dir, &cancel).unwrap_err();
    assert_eq!(damaged.kind, ModelErrorKind::Damaged);
    assert_eq!(
        damaged.message,
        "Model file is damaged: LICENSE-WEIGHTS. Remove the download after switching away, then download again."
    );
    fs::remove_file(dir.join("LICENSE-WEIGHTS")).unwrap();
    let missing = validate(&spec, &dir, &cancel).unwrap_err();
    assert_eq!(missing.kind, ModelErrorKind::Missing);
    assert_eq!(
        missing.message,
        "Model missing: LICENSE-WEIGHTS. Download it in Settings > Transcription."
    );
}

#[test]
fn verification_hashes_once_then_trusts_the_stamp() {
    let temp = TempDir::new("stamp");
    let spec = spec(None);
    let ownkey_root = temp.join("ownkey-models");
    install(&spec.install_dir(&ownkey_root));
    let registry =
        ModelRegistry::new(temp.join("data")).with_ownkey_models(Some(ownkey_root.clone()));
    let before = listing(&ownkey_root);
    let cancel = AtomicBool::new(false);

    let located = registry.locate(&spec).unwrap();
    assert_eq!(
        registry.verify(&spec, &located, &cancel).unwrap(),
        Verification::Hashed
    );
    assert!(temp
        .join("data")
        .join("models")
        .join("verified.json")
        .is_file());
    assert_eq!(
        registry.verify(&spec, &located, &cancel).unwrap(),
        Verification::Stamp
    );
    // Verifying never writes in Ownkey's folder: the stamp lives in Voice's data folder.
    assert_eq!(listing(&ownkey_root), before);

    // A file that changed since the stamp is hashed again and caught.
    let tokens = located.dir.join("tokens.txt");
    let original = fs::read(&tokens).unwrap();
    let mut changed = original.clone();
    changed[0] ^= 0xff;
    fs::write(&tokens, &changed).unwrap();
    set_modified(&tokens, Duration::from_secs(10));
    let error = registry.verify(&spec, &located, &cancel).unwrap_err();
    assert_eq!(error.kind, ModelErrorKind::Damaged);

    fs::write(&tokens, &original).unwrap();
    set_modified(&tokens, Duration::from_secs(20));
    assert_eq!(
        registry.verify(&spec, &located, &cancel).unwrap(),
        Verification::Hashed
    );
    assert_eq!(
        registry.verify(&spec, &located, &cancel).unwrap(),
        Verification::Stamp
    );
}

#[test]
fn download_installs_into_voices_own_folder() {
    let archive = RawArchive::new().model().finish();
    let served = archive.clone();
    let server = FakeServer::start(move |_| Reply::bytes(200, served.clone()));
    let temp = TempDir::new("download");
    let spec = spec(Some((&server.url("/model.tar.bz2"), &archive)));
    let ownkey_root = temp.join("ownkey-models");
    fs::create_dir_all(&ownkey_root).unwrap();
    let registry =
        ModelRegistry::new(temp.join("data")).with_ownkey_models(Some(ownkey_root.clone()));

    let mut stages = Vec::new();
    let located = registry
        .download(
            &spec,
            &mut |progress: Progress| stages.push(progress.stage),
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(located.location, Location::Voice);
    assert_eq!(located.dir, registry.own_dir(&spec));
    for (name, bytes) in FILES {
        assert_eq!(fs::read(located.dir.join(name)).unwrap(), bytes);
    }
    stages.dedup();
    assert_eq!(
        stages,
        vec![
            Stage::Downloading,
            Stage::Verifying,
            Stage::Extracting,
            Stage::Installed
        ]
    );
    // The download is stamped, so the first load needn't hash it again.
    assert_eq!(
        registry
            .verify(&spec, &located, &AtomicBool::new(false))
            .unwrap(),
        Verification::Stamp
    );
    // No temporary folder is left behind, and Ownkey's folder stays empty.
    let siblings: Vec<String> = fs::read_dir(located.dir.parent().unwrap())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(siblings, vec!["rev1"]);
    assert!(listing(&ownkey_root).is_empty());

    let again = registry
        .download(&spec, &mut |_| {}, &AtomicBool::new(false))
        .unwrap_err();
    assert_eq!(again.kind, ModelErrorKind::Refused);
    assert_eq!(
        again.message,
        "The model is already downloaded. Switch away and remove it before downloading again."
    );
}

#[test]
fn download_failures_leave_nothing_behind() {
    let archive = RawArchive::new().model().finish();
    let mut tampered = archive.clone();
    let last = tampered.len() - 1;
    tampered[last] ^= 0xff;
    let mut longer = archive.clone();
    longer.extend_from_slice(b"extra bytes");
    let cases: Vec<(Reply, &str)> = vec![
        (
            Reply::bytes(200, tampered),
            "Model archive checksum does not match. Try downloading again.",
        ),
        (
            Reply::bytes(200, longer),
            "Model archive exceeds its pinned size.",
        ),
        (
            Reply::bytes(200, archive[..archive.len() / 2].to_vec()),
            "Model archive checksum does not match. Try downloading again.",
        ),
        (
            Reply::text(404, "gone"),
            "Couldn't download the model: the server answered 404 Not Found.",
        ),
    ];
    for (reply, expected) in cases {
        let server = FakeServer::always(reply);
        let temp = TempDir::new("download-fail");
        let spec = spec(Some((&server.url("/model.tar.bz2"), &archive)));
        let registry = ModelRegistry::new(temp.join("data")).with_ownkey_models(None);
        let error = registry
            .download(&spec, &mut |_| {}, &AtomicBool::new(false))
            .unwrap_err();
        assert_eq!(error.message, expected);
        let parent = registry.own_dir(&spec).parent().unwrap().to_path_buf();
        assert!(
            listing(&parent).is_empty(),
            "left behind: {:?}",
            listing(&parent)
        );
    }
}

#[test]
fn a_cancelled_download_stops() {
    let archive = RawArchive::new().model().finish();
    let served = archive.clone();
    let server = FakeServer::start(move |_| Reply::bytes(200, served.clone()));
    let temp = TempDir::new("download-cancel");
    let spec = spec(Some((&server.url("/model.tar.bz2"), &archive)));
    let registry = ModelRegistry::new(temp.join("data")).with_ownkey_models(None);
    let error = registry
        .download(&spec, &mut |_| {}, &AtomicBool::new(true))
        .unwrap_err();
    assert_eq!(error.kind, ModelErrorKind::Cancelled);
    assert!(!registry.own_dir(&spec).exists());
}

#[test]
fn file_mode_models_are_not_downloaded_yet() {
    let temp = TempDir::new("nemotron");
    let registry = ModelRegistry::new(temp.path()).with_ownkey_models(None);
    let error = registry
        .download(&ModelSpec::nemotron(), &mut |_| {}, &AtomicBool::new(false))
        .unwrap_err();
    assert_eq!(error.kind, ModelErrorKind::Refused);
}

#[test]
fn hostile_archives_are_refused() {
    let spec = spec(None);
    let tokens = FILES[1].1;
    let unsafe_path = "Unsafe path in model archive.";
    let unexpected = "Unexpected entry in model archive.";
    let cases: Vec<(&str, Vec<u8>, String)> = vec![
        (
            "parent",
            RawArchive::new()
                .model()
                .file("../tokens.txt", tokens)
                .finish(),
            unsafe_path.into(),
        ),
        (
            "absolute",
            RawArchive::new().file("/model/tokens.txt", tokens).finish(),
            unsafe_path.into(),
        ),
        (
            "inner parent",
            RawArchive::new()
                .file("model/../tokens.txt", tokens)
                .finish(),
            unsafe_path.into(),
        ),
        (
            "backslash",
            RawArchive::new().file("model\\tokens.txt", tokens).finish(),
            unsafe_path.into(),
        ),
        (
            "drive",
            RawArchive::new()
                .file("model/C:tokens.txt", tokens)
                .finish(),
            unsafe_path.into(),
        ),
        (
            "symlink",
            RawArchive::new()
                .entry(
                    &format!("{ROOT}/tokens.txt"),
                    tar::EntryType::Symlink,
                    b"",
                    "/etc/passwd",
                )
                .finish(),
            unexpected.into(),
        ),
        (
            "hard link",
            RawArchive::new()
                .entry(
                    &format!("{ROOT}/tokens.txt"),
                    tar::EntryType::Link,
                    b"",
                    "outside",
                )
                .finish(),
            unexpected.into(),
        ),
        (
            "char device",
            RawArchive::new()
                .entry(&format!("{ROOT}/tokens.txt"), tar::EntryType::Char, b"", "")
                .finish(),
            unexpected.into(),
        ),
        (
            "wrong root",
            RawArchive::new()
                .file("other-root/tokens.txt", tokens)
                .finish(),
            unexpected.into(),
        ),
        (
            "too deep",
            RawArchive::new()
                .file(&format!("{ROOT}/sub/tokens.txt"), tokens)
                .finish(),
            unexpected.into(),
        ),
        (
            "duplicate",
            RawArchive::new()
                .model()
                .file(&format!("{ROOT}/tokens.txt"), tokens)
                .finish(),
            "Unexpected model file: tokens.txt".into(),
        ),
        (
            "unknown file",
            RawArchive::new()
                .file(&format!("{ROOT}/evil.dll"), b"x")
                .finish(),
            "Unexpected model file: evil.dll".into(),
        ),
        (
            "wrong size",
            RawArchive::new()
                .file(&format!("{ROOT}/tokens.txt"), b"other size")
                .finish(),
            "Unexpected model file: tokens.txt".into(),
        ),
        (
            "incomplete",
            RawArchive::new()
                .dir(&format!("{ROOT}/"))
                .file(&format!("{ROOT}/tokens.txt"), tokens)
                .finish(),
            "The model archive is incomplete.".into(),
        ),
    ];
    for (label, archive, expected) in cases {
        let temp = TempDir::new("hostile");
        let staging = temp.join("staging");
        fs::create_dir(&staging).unwrap();
        let error = extract(
            &spec,
            ROOT,
            archive.as_slice(),
            &staging,
            &mut |_| {},
            &AtomicBool::new(false),
        )
        .unwrap_err();
        assert_eq!(error.kind, ModelErrorKind::Archive, "{label}");
        assert_eq!(error.message, expected, "{label}");
        // Nothing appeared outside the staging folder.
        let outside: Vec<_> = listing(temp.path())
            .into_iter()
            .filter(|(path, _, _)| !path.starts_with(&staging))
            .collect();
        assert!(outside.is_empty(), "{label}: {outside:?}");
    }

    // The well-formed archive extracts.
    let temp = TempDir::new("benign");
    let staging = temp.join("staging");
    fs::create_dir(&staging).unwrap();
    let archive = RawArchive::new().model().finish();
    extract(
        &spec,
        ROOT,
        archive.as_slice(),
        &staging,
        &mut |_| {},
        &AtomicBool::new(false),
    )
    .unwrap();
    assert!(files_present(&spec, &staging));
}

#[test]
fn remove_touches_only_voices_own_pinned_files() {
    let temp = TempDir::new("remove");
    let spec = spec(None);
    let ownkey_root = temp.join("ownkey-models");
    install(&spec.install_dir(&ownkey_root));
    let registry =
        ModelRegistry::new(temp.join("data")).with_ownkey_models(Some(ownkey_root.clone()));
    let own = registry.own_dir(&spec);
    install(&own);
    let cancel = AtomicBool::new(false);
    let located = ModelRegistry::new(temp.join("data"))
        .with_ownkey_models(None)
        .locate(&spec)
        .unwrap();
    registry.verify(&spec, &located, &cancel).unwrap();
    let ownkey_before = listing(&ownkey_root);

    assert!(registry.remove(&spec).unwrap());
    assert!(!own.exists());
    assert_eq!(
        listing(&ownkey_root),
        ownkey_before,
        "Ownkey's copy is never removed"
    );
    assert_eq!(registry.locate(&spec).unwrap().location, Location::Ownkey);
    assert!(!registry.remove(&spec).unwrap());

    // Files that aren't the model's stay, and so does their folder.
    install(&own);
    fs::write(own.join("notes.txt"), b"mine").unwrap();
    assert!(registry.remove(&spec).unwrap());
    assert_eq!(fs::read_dir(&own).unwrap().count(), 1);
    assert!(own.join("notes.txt").is_file());
}

#[cfg(unix)]
#[test]
fn links_never_count_as_model_files() {
    let temp = TempDir::new("links");
    let spec = spec(None);
    let real = temp.join("real");
    install(&real);
    let linked_dir = temp.join("linked-dir");
    std::os::unix::fs::symlink(&real, &linked_dir).unwrap();
    assert!(!files_present(&spec, &linked_dir));
    let linked_files = temp.join("linked-files");
    fs::create_dir(&linked_files).unwrap();
    for (name, _) in FILES {
        std::os::unix::fs::symlink(real.join(name), linked_files.join(name)).unwrap();
    }
    assert!(!files_present(&spec, &linked_files));
}
