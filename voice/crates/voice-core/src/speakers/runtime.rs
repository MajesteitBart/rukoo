//! Where the NeMo-Speech.cpp runtime is: Voice's own copy next to the exe, checked against the
//! committed manifest, or Ownkey's copy when its files match Ownkey's known hashes.
//!
//! The order is fixed: a development copy's `RUKOO_VOICE_NEMO_DIR`, then `nemo_speech\` next to
//! the exe, then the installed Ownkey's folder, read only. Voice never writes in any of them.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use super::api::RUNTIME_FOLDER;
use crate::local::sha256_file;
use crate::paths;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeLocation {
    Voice,
    Ownkey,
    Dev,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub dir: PathBuf,
    pub location: RuntimeLocation,
    /// The NeMo-Speech.cpp commit the runtime was built from, as its 7-character short hash.
    /// Empty for a development folder that doesn't say.
    pub commit: String,
}

impl RuntimeInfo {
    /// Folders besides `dir` that the worker searches for the runtime's own imports: for
    /// Ownkey's copy, its C runtime one folder up, which the worker's DLL search wouldn't find
    /// on a PC without a system copy.
    pub fn dll_dirs(&self) -> Vec<PathBuf> {
        match self.location {
            RuntimeLocation::Ownkey => self
                .dir
                .parent()
                .map(Path::to_path_buf)
                .into_iter()
                .collect(),
            RuntimeLocation::Voice | RuntimeLocation::Dev => Vec::new(),
        }
    }
}

/// voice/nemo-runtime/manifest.json: the files of Voice's own runtime build and their hashes.
/// build.rs copies it, or the manifest a test package names (`package.ps1 -RuntimeManifest`).
pub(crate) const MANIFEST: &str = include_str!(concat!(env!("OUT_DIR"), "/nemo-runtime.json"));

/// The five DLLs of every runtime folder. The worker loads the first; it loads the others.
pub(crate) const RUNTIME_DLLS: [&str; 5] = [
    "nemo_speech_asr_c.dll",
    "nemo_speech_asr.dll",
    "ggml.dll",
    "ggml-base.dll",
    "ggml-cpu.dll",
];

/// The Visual C++ runtime the five DLLs import. Voice's own folder holds it; Ownkey's sits one
/// folder up, in Ownkey's `_internal\`.
pub(crate) const CRT_DLLS: [&str; 3] = ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"];

/// The NeMo-Speech.cpp commit of Ownkey's runtime: the same one Voice builds.
const OWNKEY_COMMIT: &str = "97a15afa5caa9bce5baaa86c1184103877af4101";

/// The installed Ownkey's build of that commit (2026-10-02): size and SHA-256 per DLL, from its
/// `runtime.json`. Its MSVC runtime sits one folder up: it has to be there, unhashed.
const OWNKEY_RUNTIME: [(&str, u64, &str); 5] = [
    (
        "nemo_speech_asr_c.dll",
        56_320,
        "c45eeb7c158d40f1b523b6a306376ad06a339b7a0ec53722fb0a5790dbffd51d",
    ),
    (
        "nemo_speech_asr.dll",
        4_195_840,
        "68da916f37fe8b1bcc051c6e9d161ce7bcfb822fe5ecdbe8a559d59146e6eaf0",
    ),
    (
        "ggml.dll",
        67_072,
        "e7fbe5d6eb20ae2a5056af4050016ad9a487b7fa8f2590657a0f3942a98210c5",
    ),
    (
        "ggml-base.dll",
        623_616,
        "86ce9be60062561491c4febbec02b5664d84eb7a100c5f55f75f374fa99eb2dc",
    ),
    (
        "ggml-cpu.dll",
        786_432,
        "aaecc8a7984d92ca5ec1d3a15a54fcb371e15fb912626d2d31e8bb86cc9e415c",
    ),
];

/// The parts of the manifest the lookup reads. Until the runtime is published `archive` is null
/// and `files` empty, and then Voice's own copy never verifies.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
pub(crate) struct Manifest {
    #[serde(default)]
    pub format: u64,
    #[serde(default)]
    pub commit: String,
    #[serde(default)]
    pub files: Option<Vec<ManifestFile>>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub(crate) struct ManifestFile {
    /// Relative to the runtime folder, with `/` between parts.
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

impl Manifest {
    pub(crate) fn parse(text: &str) -> Option<Manifest> {
        serde_json::from_str(text).ok()
    }

    fn files(&self) -> &[ManifestFile] {
        self.files.as_deref().unwrap_or_default()
    }
}

/// The compiled-in manifest. A manifest Voice can't read verifies nothing.
pub(crate) fn manifest() -> &'static Manifest {
    static PARSED: OnceLock<Manifest> = OnceLock::new();
    PARSED.get_or_init(|| Manifest::parse(MANIFEST).unwrap_or_default())
}

/// Finds a runtime folder that verifies: the development override, then the folder next to the
/// exe, then Ownkey's. Hashes are cached by path, size and modification time.
pub fn locate_runtime(exe_dir: &Path, dev_mode: bool) -> Option<RuntimeInfo> {
    let dev = dev_dir_in(dev_mode, &paths::env_var);
    let ownkey = paths::ownkey_nemo_runtime();
    locate_in(exe_dir, dev.as_deref(), ownkey.as_deref(), manifest())
}

/// `RUKOO_VOICE_NEMO_DIR`, in development mode only.
pub(crate) fn dev_dir_in(dev_mode: bool, env: &dyn Fn(&str) -> Option<String>) -> Option<PathBuf> {
    if !dev_mode {
        return None;
    }
    env(paths::NEMO_DIR_ENV)
        .filter(|dir| !dir.trim().is_empty())
        .map(PathBuf::from)
}

/// The lookup with every input explicit: `dev` is a development folder (already gated on
/// development mode), `ownkey` Ownkey's runtime folder.
pub(crate) fn locate_in(
    exe_dir: &Path,
    dev: Option<&Path>,
    ownkey: Option<&Path>,
    manifest: &Manifest,
) -> Option<RuntimeInfo> {
    if let Some(dir) = dev.filter(|dir| dev_runtime_present(dir)) {
        return Some(RuntimeInfo {
            dir: dir.to_path_buf(),
            location: RuntimeLocation::Dev,
            commit: dev_commit(dir),
        });
    }
    let own = exe_dir.join(RUNTIME_FOLDER);
    if verify_voice(&own, manifest) {
        return Some(RuntimeInfo {
            dir: own,
            location: RuntimeLocation::Voice,
            commit: short_commit(&manifest.commit),
        });
    }
    if let Some(dir) = ownkey.filter(|dir| verify_ownkey(dir)) {
        return Some(RuntimeInfo {
            dir: dir.to_path_buf(),
            location: RuntimeLocation::Ownkey,
            commit: short_commit(OWNKEY_COMMIT),
        });
    }
    None
}

fn short_commit(commit: &str) -> String {
    commit.trim().chars().take(7).collect()
}

fn is_link(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink())
}

/// A development folder needs the five DLLs; its hashes aren't checked.
fn dev_runtime_present(dir: &Path) -> bool {
    RUNTIME_DLLS
        .iter()
        .all(|name| fs::metadata(dir.join(name)).is_ok_and(|meta| meta.is_file()))
}

/// The commit a development folder's `runtime.json` names, if any.
fn dev_commit(dir: &Path) -> String {
    fs::read(dir.join("runtime.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|value| value.get("commit")?.as_str().map(short_commit))
        .unwrap_or_default()
}

/// Voice's own copy: every file of the manifest, at its size and hash. An empty manifest, one of
/// another format, or a folder that is a link never verifies.
pub(crate) fn verify_voice(dir: &Path, manifest: &Manifest) -> bool {
    let files = manifest.files();
    manifest.format == 1
        && !files.is_empty()
        && !is_link(dir)
        && files.iter().all(|file| {
            relative(&file.path)
                .is_some_and(|path| file_matches(&dir.join(path), file.size, &file.sha256))
        })
}

/// Ownkey's copy: its five DLLs at the known sizes and hashes, and its C runtime one folder up.
pub(crate) fn verify_ownkey(dir: &Path) -> bool {
    verify_ownkey_with(dir, &OWNKEY_RUNTIME)
}

fn verify_ownkey_with(dir: &Path, known: &[(&str, u64, &str)]) -> bool {
    verify_known(dir, known) && crt_beside(dir)
}

/// Ownkey's C runtime in the folder above its runtime folder. Without it the DLLs load only on a
/// PC that has a system copy, so such a folder doesn't count as a runtime.
fn crt_beside(dir: &Path) -> bool {
    dir.parent().is_some_and(|up| {
        CRT_DLLS.iter().all(|name| {
            fs::symlink_metadata(up.join(name)).is_ok_and(|meta| meta.file_type().is_file())
        })
    })
}

fn verify_known(dir: &Path, known: &[(&str, u64, &str)]) -> bool {
    !is_link(dir)
        && known
            .iter()
            .all(|(name, size, sha256)| file_matches(&dir.join(name), *size, sha256))
}

/// A manifest path as a relative path, refusing anything that could leave the folder.
fn relative(path: &str) -> Option<PathBuf> {
    let parts: Vec<&str> = path.split('/').collect();
    let unsafe_part = |part: &&str| {
        part.is_empty() || *part == "." || *part == ".." || part.contains(['\\', ':'])
    };
    if parts.iter().any(unsafe_part) {
        return None;
    }
    Some(parts.iter().collect())
}

struct Hashed {
    path: PathBuf,
    size: u64,
    modified: Option<SystemTime>,
    sha256: String,
}

/// Hashes already computed in this process. Settings asks on every refresh, and Ownkey's runtime
/// alone is 5.7 MB.
static HASHES: Mutex<Vec<Hashed>> = Mutex::new(Vec::new());

/// A regular file (not a link) with this size and SHA-256.
fn file_matches(path: &Path, size: u64, sha256: &str) -> bool {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return false;
    };
    if !meta.file_type().is_file() || meta.len() != size {
        return false;
    }
    let modified = meta.modified().ok();
    let cached = HASHES
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .iter()
        .find(|hashed| hashed.path == path && hashed.size == size && hashed.modified == modified)
        .map(|hashed| hashed.sha256.clone());
    let actual = match cached {
        Some(actual) => actual,
        None => {
            let Ok(actual) = sha256_file(path, &AtomicBool::new(false)) else {
                return false;
            };
            let mut hashes = HASHES.lock().unwrap_or_else(PoisonError::into_inner);
            hashes.retain(|hashed| hashed.path != path);
            hashes.push(Hashed {
                path: path.to_path_buf(),
                size,
                modified,
                sha256: actual.clone(),
            });
            actual
        }
    };
    actual.eq_ignore_ascii_case(sha256.trim())
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::fs;
    use std::time::{Duration, SystemTime};

    use super::*;
    use crate::speakers::tests::TempDir;

    fn sha(path: &Path) -> String {
        sha256_file(path, &AtomicBool::new(false)).unwrap()
    }

    /// A runtime folder with the five DLLs and a licence, plus the manifest that pins it.
    fn runtime_folder(dir: &Path) -> Manifest {
        fs::create_dir_all(dir.join("licenses")).unwrap();
        let mut files = Vec::new();
        for (i, name) in RUNTIME_DLLS.iter().chain(&["licenses/LICENSE"]).enumerate() {
            let path = dir.join(relative(name).unwrap());
            fs::write(&path, format!("fake file {i}: {name}")).unwrap();
            files.push(ManifestFile {
                path: name.to_string(),
                size: fs::metadata(&path).unwrap().len(),
                sha256: sha(&path).to_uppercase(),
            });
        }
        Manifest {
            format: 1,
            commit: OWNKEY_COMMIT.into(),
            files: Some(files),
        }
    }

    #[test]
    fn the_committed_manifest_parses_before_and_after_publishing() {
        let committed = Manifest::parse(MANIFEST).expect("voice/nemo-runtime/manifest.json");
        assert_eq!(committed.format, 1);
        assert_eq!(committed.commit, OWNKEY_COMMIT);
        assert_eq!(manifest(), &committed);
        // The unpublished shape: null archive, no files, null toolset entries.
        let unpublished = Manifest::parse(
            r#"{"format": 1, "commit": "97a15afa", "archive": null, "files": [], "toolset": {"msvc": null}}"#,
        )
        .unwrap();
        assert!(unpublished.files().is_empty());
        let null_files = Manifest::parse(r#"{"format": 1, "files": null}"#).unwrap();
        assert!(null_files.files().is_empty());
        // The published shape, with CRT versions and an archive.
        let published = Manifest::parse(
            r#"{"format": 1, "commit": "97a15afa", "archive": {"url": "https://x/y.zip", "size": 1, "sha256": "ab"},
                "files": [{"path": "msvcp140.dll", "size": 3, "sha256": "cd", "version": "14.44"}]}"#,
        )
        .unwrap();
        assert_eq!(published.files()[0].path, "msvcp140.dll");
    }

    #[test]
    fn an_unpublished_manifest_never_verifies() {
        let temp = TempDir::new("runtime-unpublished");
        let dir = temp.join(RUNTIME_FOLDER);
        runtime_folder(&dir);
        if manifest().files().is_empty() {
            assert!(!verify_voice(&dir, manifest()));
        }
        assert!(!verify_voice(&dir, &Manifest::default()));
    }

    #[test]
    fn voices_copy_verifies_against_its_manifest() {
        let temp = TempDir::new("runtime-voice");
        let exe_dir = temp.path();
        let dir = exe_dir.join(RUNTIME_FOLDER);
        let pinned = runtime_folder(&dir);
        assert!(verify_voice(&dir, &pinned));
        let found = locate_in(exe_dir, None, None, &pinned).unwrap();
        assert_eq!(
            found,
            RuntimeInfo {
                dir: dir.clone(),
                location: RuntimeLocation::Voice,
                commit: "97a15af".into(),
            }
        );
        // Another format isn't read as this one.
        let other = Manifest {
            format: 2,
            ..pinned.clone()
        };
        assert!(!verify_voice(&dir, &other));
        // A path that leaves the folder never verifies.
        let mut escaping = pinned.clone();
        escaping.files.as_mut().unwrap()[5].path = "../LICENSE".into();
        assert!(!verify_voice(&dir, &escaping));
    }

    #[test]
    fn one_changed_byte_fails_even_with_a_warm_cache() {
        let temp = TempDir::new("runtime-changed");
        let dir = temp.join(RUNTIME_FOLDER);
        let pinned = runtime_folder(&dir);
        assert!(verify_voice(&dir, &pinned));
        let dll = dir.join("ggml-cpu.dll");
        let mut bytes = fs::read(&dll).unwrap();
        bytes[0] ^= 0x01;
        fs::write(&dll, &bytes).unwrap();
        // Same size; a new modification time makes the cache hash again.
        let file = fs::OpenOptions::new().write(true).open(&dll).unwrap();
        file.set_modified(SystemTime::now() + Duration::from_secs(30))
            .unwrap();
        drop(file);
        assert!(!verify_voice(&dir, &pinned));
        assert_eq!(locate_in(temp.path(), None, None, &pinned), None);
        // A missing file fails too.
        bytes[0] ^= 0x01;
        fs::write(&dll, &bytes).unwrap();
        fs::remove_file(dir.join("licenses").join("LICENSE")).unwrap();
        assert!(!verify_voice(&dir, &pinned));
    }

    #[test]
    fn ownkeys_folder_with_other_hashes_is_skipped() {
        let temp = TempDir::new("runtime-ownkey");
        let ownkey = temp.join("ownkey").join("nemo_speech");
        fs::create_dir_all(&ownkey).unwrap();
        // The right names and sizes, other bytes.
        for (name, size, _) in OWNKEY_RUNTIME {
            fs::write(ownkey.join(name), vec![0u8; size as usize]).unwrap();
        }
        assert!(!verify_ownkey(&ownkey));
        assert_eq!(
            locate_in(&temp.join("exe"), None, Some(&ownkey), &Manifest::default()),
            None
        );
        // The same rule with hashes this test knows does find it.
        let known: Vec<(String, u64, String)> = OWNKEY_RUNTIME
            .iter()
            .map(|(name, size, _)| (name.to_string(), *size, sha(&ownkey.join(name))))
            .collect();
        let known: Vec<(&str, u64, &str)> = known
            .iter()
            .map(|(name, size, sha)| (name.as_str(), *size, sha.as_str()))
            .collect();
        assert!(verify_known(&ownkey, &known));
    }

    #[test]
    fn ownkeys_folder_counts_only_with_its_c_runtime_one_folder_up() {
        let temp = TempDir::new("runtime-ownkey-crt");
        let internal = temp.join("_internal");
        let ownkey = internal.join("nemo_speech");
        fs::create_dir_all(&ownkey).unwrap();
        for (i, name) in RUNTIME_DLLS.iter().enumerate() {
            fs::write(ownkey.join(name), format!("fake dll {i}")).unwrap();
        }
        let known: Vec<(String, u64, String)> = RUNTIME_DLLS
            .iter()
            .map(|name| {
                let path = ownkey.join(name);
                (
                    name.to_string(),
                    fs::metadata(&path).unwrap().len(),
                    sha(&path),
                )
            })
            .collect();
        let known: Vec<(&str, u64, &str)> = known
            .iter()
            .map(|(name, size, sha)| (name.as_str(), *size, sha.as_str()))
            .collect();
        assert!(verify_known(&ownkey, &known));
        // The DLLs match, but nothing they import is there.
        assert!(!verify_ownkey_with(&ownkey, &known));
        for name in &CRT_DLLS[..2] {
            fs::write(internal.join(name), "crt").unwrap();
        }
        assert!(
            !verify_ownkey_with(&ownkey, &known),
            "one of three is missing"
        );
        fs::write(internal.join(CRT_DLLS[2]), "crt").unwrap();
        assert!(verify_ownkey_with(&ownkey, &known));
        // The worker searches that folder too.
        let info = RuntimeInfo {
            dir: ownkey.clone(),
            location: RuntimeLocation::Ownkey,
            commit: "97a15af".into(),
        };
        assert_eq!(info.dll_dirs(), vec![internal.clone()]);
        for location in [RuntimeLocation::Voice, RuntimeLocation::Dev] {
            assert!(RuntimeInfo {
                location,
                ..info.clone()
            }
            .dll_dirs()
            .is_empty());
        }
    }

    #[test]
    fn voices_copy_comes_before_ownkeys_and_dev_before_both() {
        let temp = TempDir::new("runtime-order");
        let exe_dir = temp.join("exe");
        let pinned = runtime_folder(&exe_dir.join(RUNTIME_FOLDER));
        let dev = temp.join("dev");
        runtime_folder(&dev);
        fs::write(
            dev.join("runtime.json"),
            r#"{"commit": "0123456789abcdef"}"#,
        )
        .unwrap();
        let found = locate_in(&exe_dir, Some(&dev), None, &pinned).unwrap();
        assert_eq!(found.location, RuntimeLocation::Dev);
        assert_eq!(found.dir, dev);
        assert_eq!(found.commit, "0123456");
        // A development folder without the DLLs falls through to Voice's copy.
        let empty = temp.join("empty");
        fs::create_dir_all(&empty).unwrap();
        let found = locate_in(&exe_dir, Some(&empty), None, &pinned).unwrap();
        assert_eq!(found.location, RuntimeLocation::Voice);
    }

    #[test]
    fn the_development_folder_is_ignored_outside_development_mode() {
        let env: HashMap<String, String> =
            HashMap::from([(paths::NEMO_DIR_ENV.to_string(), "E:\\nemo".to_string())]);
        let lookup = |name: &str| env.get(name).cloned();
        assert_eq!(dev_dir_in(false, &lookup), None);
        assert_eq!(dev_dir_in(true, &lookup), Some(PathBuf::from("E:\\nemo")));
        let blank = |_: &str| Some("  ".to_string());
        assert_eq!(dev_dir_in(true, &blank), None);
    }

    #[test]
    fn ownkeys_pins_are_lower_case_sha256() {
        for (name, size, sha) in OWNKEY_RUNTIME {
            assert!(RUNTIME_DLLS.contains(&name));
            assert!(size > 0);
            assert_eq!(sha.len(), 64);
            assert!(sha
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        }
    }
}
