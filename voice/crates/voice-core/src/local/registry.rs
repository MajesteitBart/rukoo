//! The pinned local models, where they are, and whether their files can be trusted.
//!
//! A model is looked for in the folder the user chose, then in Ownkey's shared folder, then in
//! Voice's own `models/`. Files are checked against the pinned SHA-256 once; after that a stamp
//! of their sizes and modification times in Voice's data folder lets later loads skip hashing
//! 672 MB. Voice never writes, moves or deletes anything in Ownkey's folder.

use std::fmt;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::config::Config;
use crate::fsutil;
use crate::paths;

const BLOCK: usize = 1 << 20;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelFile {
    pub name: String,
    pub size: u64,
    pub sha256: String,
    /// Set for models downloaded file by file instead of as one archive.
    pub url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Archive {
    pub url: String,
    pub size: u64,
    pub sha256: String,
    /// The single folder every file sits in inside the archive.
    pub root: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelSpec {
    pub id: String,
    pub label: String,
    pub revision: String,
    /// Install path under a models root: `<root>/<folder>/<revision>`.
    pub folder: String,
    /// The Settings page that downloads it, for messages.
    pub settings_page: String,
    /// Whether the "Model folder" setting applies to this model.
    pub custom_folder: bool,
    pub archive: Option<Archive>,
    pub files: Vec<ModelFile>,
}

fn file(name: &str, size: u64, sha256: &str) -> ModelFile {
    ModelFile {
        name: name.into(),
        size,
        sha256: sha256.into(),
        url: None,
    }
}

impl ModelSpec {
    /// Orukeet by Oruk AI, pinned by archive hash (`local_models.py:19-63`). Ownkey installs it
    /// under the literal folder "orukeet", not its id, and Voice uses the same layout.
    pub fn orukeet() -> ModelSpec {
        const REVISION: &str = "55a984d46f68323301837194ce647c702f55facc";
        ModelSpec {
            id: "orukeet-onnx-int8".into(),
            label: "Orukeet".into(),
            revision: REVISION.into(),
            folder: "orukeet".into(),
            settings_page: "Transcription".into(),
            custom_folder: true,
            archive: Some(Archive {
                url: format!(
                    "https://huggingface.co/oruk/orukeet/resolve/{REVISION}/onnx/sherpa-onnx-orukeet-v0.1.0-int8.tar.bz2"
                ),
                size: 486_807_585,
                sha256: "f9191f30178cc9122ce2f023bf9fefafc822028307b0efa4caff645ba3fe8d0a".into(),
                root: "sherpa-onnx-orukeet-v0.1.0-int8".into(),
            }),
            files: vec![
                file("encoder.int8.onnx", 653_182_378, "7b55f2a504a20a8e462899f5befd45f4a1784948d76ed0127902d9cf39405487"),
                file("decoder.int8.onnx", 11_845_332, "c185c2afb4c77c94bb1314807ecb3dc1623057a3dc540b83e10301af9bf4cfca"),
                file("joiner.int8.onnx", 6_355_335, "1a7e90abf7172d926dd7e2edac2a5d5035c24dfb641a15e131d57b6a5f63cdd3"),
                file("tokens.txt", 93_939, "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d"),
                file("bpe.vocab", 117_408, "41d5e71b3591642eff088151efd7acd4e750124cc0054c8ba9fa3245187a4804"),
                // Attribution for the CC BY-SA 4.0 weights; it stays with the download.
                file("LICENSE-WEIGHTS", 20_137, "23ee78c8bae49cf08ea2f0c84945c66b987ebe4520881fb51b3dad4fb43d07c2"),
                file("NOTICE.md", 5_271, "440361d963edd9621e744f251332b47f2c4de2e2594ecfe42b215e3f6223fa44"),
            ],
        }
    }

    /// NVIDIA Nemotron 3 Diarization (`local_diarization.py:21-31`). Speaker labels come after
    /// 0.1; Voice only finds and verifies Ownkey's copy for now.
    pub fn nemotron() -> ModelSpec {
        const REVISION: &str = "f667ed73aee57d40cc39428eb768b4fd87a0a29e";
        let mut gguf = file(
            "Nemotron-3-Diarization.q8_0.gguf",
            107_012_128,
            "08456d9e22cd9a323c0364d98375f3746d6e68507ebb705cd46438c534c7a3a1",
        );
        gguf.url = Some(format!(
            "https://huggingface.co/nvidia/Nemotron-3-Diarization/resolve/{REVISION}/Nemotron-3-Diarization.q8_0.gguf"
        ));
        ModelSpec {
            id: "nemotron-3-diarization".into(),
            label: "Nemotron 3 Diarization".into(),
            revision: REVISION.into(),
            folder: "nemotron-3-diarization".into(),
            settings_page: "Meetings".into(),
            custom_folder: false,
            archive: None,
            files: vec![gguf],
        }
    }

    pub fn extracted_size(&self) -> u64 {
        self.files.iter().map(|f| f.size).sum()
    }

    pub fn install_dir(&self, models_root: &Path) -> PathBuf {
        models_root.join(&self.folder).join(&self.revision)
    }

    fn missing(&self, name: &str) -> ModelError {
        ModelError::new(
            ModelErrorKind::Missing,
            format!(
                "Model missing: {name}. Download it in Settings > {}.",
                self.settings_page
            ),
        )
    }

    fn damaged(&self, name: &str) -> ModelError {
        ModelError::new(
            ModelErrorKind::Damaged,
            format!("Model file is damaged: {name}. Remove the download after switching away, then download again."),
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelErrorKind {
    Missing,
    Damaged,
    Cancelled,
    Busy,
    Refused,
    Archive,
    Download,
    Disk,
    Io,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ModelError {
    pub kind: ModelErrorKind,
    pub message: String,
}

impl ModelError {
    pub fn new(kind: ModelErrorKind, message: impl Into<String>) -> ModelError {
        ModelError {
            kind,
            message: message.into(),
        }
    }

    pub(crate) fn cancelled() -> ModelError {
        ModelError::new(ModelErrorKind::Cancelled, "The download was cancelled.")
    }

    pub(crate) fn io(error: io::Error) -> ModelError {
        ModelError::new(ModelErrorKind::Io, error.to_string())
    }
}

impl fmt::Display for ModelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ModelError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Location {
    /// The folder chosen under "Model folder".
    Custom,
    /// Ownkey's shared folder. Settings says the model belongs to Ownkey.
    Ownkey,
    /// Voice's own `models/`. Only these can be removed.
    Voice,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Located {
    pub dir: PathBuf,
    pub location: Location,
}

impl Located {
    pub fn removable(&self) -> bool {
        self.location == Location::Voice
    }
}

/// How `verify` trusted the files.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verification {
    /// Every file was hashed; the stamp was written.
    Hashed,
    /// Sizes and modification times matched the stamp from an earlier hash.
    Stamp,
}

fn is_link(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink())
}

/// Cheap check before every use: the folder isn't a link and every pinned file is a regular
/// file (not a link) with the pinned size.
pub fn files_present(spec: &ModelSpec, dir: &Path) -> bool {
    if is_link(dir) {
        return false;
    }
    spec.files.iter().all(|file| {
        fs::symlink_metadata(dir.join(&file.name))
            .is_ok_and(|meta| meta.file_type().is_file() && meta.len() == file.size)
    })
}

/// Hashes every pinned file. `cancel` stops it between blocks.
pub fn validate(spec: &ModelSpec, dir: &Path, cancel: &AtomicBool) -> Result<(), ModelError> {
    for file in &spec.files {
        let path = dir.join(&file.name);
        let meta = fs::symlink_metadata(&path).map_err(|_| spec.missing(&file.name))?;
        if !meta.file_type().is_file() {
            return Err(spec.missing(&file.name));
        }
        if meta.len() != file.size || sha256_file(&path, cancel)? != file.sha256 {
            return Err(spec.damaged(&file.name));
        }
    }
    Ok(())
}

pub(crate) fn sha256_file(path: &Path, cancel: &AtomicBool) -> Result<String, ModelError> {
    let mut input = File::open(path).map_err(ModelError::io)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; BLOCK];
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(ModelError::cancelled());
        }
        let read = input.read(&mut buffer).map_err(ModelError::io)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex(&hasher.finalize()))
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
struct Stamps {
    version: u32,
    entries: Vec<StampEntry>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct StampEntry {
    model: String,
    revision: String,
    dir: String,
    files: Vec<StampFile>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct StampFile {
    name: String,
    size: u64,
    modified_ns: u64,
}

/// Where Voice looks for models and keeps its own downloads and stamps.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelRegistry {
    data_dir: PathBuf,
    ownkey_models: Option<PathBuf>,
    custom_dir: Option<PathBuf>,
}

impl ModelRegistry {
    /// Voice's data folder, with Ownkey's model folder on this computer.
    pub fn new(data_dir: impl Into<PathBuf>) -> ModelRegistry {
        ModelRegistry {
            data_dir: data_dir.into(),
            ownkey_models: paths::ownkey_models(),
            custom_dir: None,
        }
    }

    /// The registry for the current settings: the "Model folder" choice applies.
    pub fn for_config(data_dir: impl Into<PathBuf>, cfg: &Config) -> ModelRegistry {
        let custom = Some(cfg.local_model_directory.trim())
            .filter(|dir| !dir.is_empty())
            .map(PathBuf::from);
        ModelRegistry::new(data_dir).with_custom_dir(custom)
    }

    pub fn with_ownkey_models(mut self, dir: Option<PathBuf>) -> ModelRegistry {
        self.ownkey_models = dir;
        self
    }

    pub fn with_custom_dir(mut self, dir: Option<PathBuf>) -> ModelRegistry {
        self.custom_dir = dir;
        self
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// Voice's own model folder, `<data>/models`.
    pub fn own_root(&self) -> PathBuf {
        paths::models_dir(&self.data_dir)
    }

    pub fn own_dir(&self, spec: &ModelSpec) -> PathBuf {
        spec.install_dir(&self.own_root())
    }

    fn stamp_file(&self) -> PathBuf {
        self.own_root().join("verified.json")
    }

    /// Every place the model may be, in the order they are tried.
    pub fn candidates(&self, spec: &ModelSpec) -> Vec<Located> {
        let mut candidates = Vec::new();
        if spec.custom_folder {
            if let Some(dir) = &self.custom_dir {
                candidates.push(Located {
                    dir: dir.clone(),
                    location: Location::Custom,
                });
            }
        }
        if let Some(root) = &self.ownkey_models {
            candidates.push(Located {
                dir: spec.install_dir(root),
                location: Location::Ownkey,
            });
        }
        candidates.push(Located {
            dir: self.own_dir(spec),
            location: Location::Voice,
        });
        candidates
    }

    /// The first place that has every pinned file with the right size.
    pub fn locate(&self, spec: &ModelSpec) -> Option<Located> {
        self.candidates(spec)
            .into_iter()
            .find(|candidate| files_present(spec, &candidate.dir))
    }

    /// Checks the files against the pinned hashes, or trusts the stamp from an earlier check
    /// when no file changed size or modification time since.
    pub fn verify(
        &self,
        spec: &ModelSpec,
        located: &Located,
        cancel: &AtomicBool,
    ) -> Result<Verification, ModelError> {
        let fingerprint = fingerprint(spec, &located.dir)?;
        let key = located.dir.display().to_string();
        let mut stamps = self.read_stamps();
        let stamped = stamps.entries.iter().any(|e| {
            e.model == spec.id
                && e.revision == spec.revision
                && e.dir == key
                && e.files == fingerprint
        });
        if stamped {
            return Ok(Verification::Stamp);
        }
        validate(spec, &located.dir, cancel)?;
        stamps
            .entries
            .retain(|e| !(e.model == spec.id && e.dir == key));
        stamps.entries.push(StampEntry {
            model: spec.id.clone(),
            revision: spec.revision.clone(),
            dir: key,
            files: fingerprint,
        });
        stamps.version = 1;
        // A stamp that can't be written only costs a hash next time.
        let _ = self.write_stamps(&stamps);
        Ok(Verification::Hashed)
    }

    fn read_stamps(&self) -> Stamps {
        fs::read(self.stamp_file())
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    fn write_stamps(&self, stamps: &Stamps) -> io::Result<()> {
        fs::create_dir_all(self.own_root())?;
        let bytes = serde_json::to_vec_pretty(stamps).map_err(io::Error::other)?;
        fsutil::write_atomic(&self.stamp_file(), &bytes)
    }

    fn forget_stamp(&self, spec: &ModelSpec, dir: &Path) {
        let key = dir.display().to_string();
        let mut stamps = self.read_stamps();
        let before = stamps.entries.len();
        stamps
            .entries
            .retain(|e| !(e.model == spec.id && e.dir == key));
        if stamps.entries.len() != before {
            let _ = self.write_stamps(&stamps);
        }
    }

    /// Downloads and installs the model into Voice's own `models/`, verified against the pins.
    /// `progress` gets every stage; `cancel` stops the download between blocks.
    pub fn download(
        &self,
        spec: &ModelSpec,
        progress: &mut dyn FnMut(super::Progress),
        cancel: &AtomicBool,
    ) -> Result<Located, ModelError> {
        let located = super::download::download(self, spec, progress, cancel)?;
        let fingerprint = fingerprint(spec, &located.dir)?;
        let mut stamps = self.read_stamps();
        let key = located.dir.display().to_string();
        stamps
            .entries
            .retain(|e| !(e.model == spec.id && e.dir == key));
        stamps.entries.push(StampEntry {
            model: spec.id.clone(),
            revision: spec.revision.clone(),
            dir: key,
            files: fingerprint,
        });
        stamps.version = 1;
        let _ = self.write_stamps(&stamps);
        Ok(located)
    }

    /// Removes Voice's own copy: only the pinned files, then the folder if nothing else is in
    /// it. Copies in Ownkey's folder or a chosen folder are never touched. The caller makes sure
    /// the model isn't loaded. Returns whether anything was removed.
    pub fn remove(&self, spec: &ModelSpec) -> Result<bool, ModelError> {
        let dir = self.own_dir(spec);
        if is_link(&dir) {
            return Err(ModelError::new(
                ModelErrorKind::Refused,
                "Choose a model folder without a symbolic link or junction.",
            ));
        }
        if !dir.exists() {
            return Ok(false);
        }
        let mut removed = false;
        for file in &spec.files {
            match fs::remove_file(dir.join(&file.name)) {
                Ok(()) => removed = true,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(ModelError::io(error)),
            }
        }
        // Only empty folders go; anything else in them stays.
        if fs::remove_dir(&dir).is_ok() {
            let _ = fs::remove_dir(dir.parent().unwrap_or(&dir));
        }
        self.forget_stamp(spec, &dir);
        Ok(removed)
    }
}

fn modified_ns(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |elapsed| elapsed.as_nanos() as u64)
}

fn fingerprint(spec: &ModelSpec, dir: &Path) -> Result<Vec<StampFile>, ModelError> {
    if is_link(dir) {
        return Err(spec.missing(spec.files.first().map_or("", |f| f.name.as_str())));
    }
    spec.files
        .iter()
        .map(|file| {
            let meta =
                fs::symlink_metadata(dir.join(&file.name)).map_err(|_| spec.missing(&file.name))?;
            if !meta.file_type().is_file() {
                return Err(spec.missing(&file.name));
            }
            if meta.len() != file.size {
                return Err(spec.damaged(&file.name));
            }
            Ok(StampFile {
                name: file.name.clone(),
                size: meta.len(),
                modified_ns: modified_ns(&meta),
            })
        })
        .collect()
}
