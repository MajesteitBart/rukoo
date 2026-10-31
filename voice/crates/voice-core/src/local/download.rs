//! Downloading a pinned model archive into Voice's own `models/` (`local_models.py:198-337`).
//!
//! The archive goes to a temporary folder next to the install folder, is checked against its
//! pinned size and SHA-256, and is extracted with strict rules: every entry must be one of the
//! pinned files, at exactly one level under the archive's root folder, with its pinned size.
//! The finished folder replaces the old one in one rename.

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};

use super::registry::{
    files_present, hex, validate, Located, Location, ModelError, ModelErrorKind, ModelRegistry,
    ModelSpec,
};
use crate::fsutil;

const BLOCK: usize = 1 << 20;
/// Headroom on top of the archive and the extracted files, as Ownkey asks for.
const SPARE_BYTES: u64 = 64 << 20;
const NETWORK_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum Stage {
    Downloading,
    Verifying,
    Extracting,
    Installed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Progress {
    pub stage: Stage,
    pub done: u64,
    pub total: Option<u64>,
}

/// Install folders with a download running in this process; a second one into the same folder
/// is refused.
static RUNNING: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

struct RunningGuard(PathBuf);

impl Drop for RunningGuard {
    fn drop(&mut self) {
        if let Ok(mut running) = RUNNING.lock() {
            running.retain(|dir| dir != &self.0);
        }
    }
}

fn archive_error(message: impl Into<String>) -> ModelError {
    ModelError::new(ModelErrorKind::Archive, message)
}

fn check_cancel(cancel: &AtomicBool) -> Result<(), ModelError> {
    if cancel.load(Ordering::Relaxed) {
        Err(ModelError::cancelled())
    } else {
        Ok(())
    }
}

fn is_link(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink())
}

/// Refuses an install folder that is a link, or that holds anything besides the pinned files.
fn check_replaceable(spec: &ModelSpec, dir: &Path) -> Result<(), ModelError> {
    if is_link(dir) {
        return Err(ModelError::new(
            ModelErrorKind::Refused,
            "Choose a model folder without a symbolic link or junction.",
        ));
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let regular = entry.file_type().is_ok_and(|kind| kind.is_file());
        if !regular || !spec.files.iter().any(|file| file.name == name) {
            return Err(ModelError::new(
                ModelErrorKind::Refused,
                "This folder contains other files. Choose an empty folder for the download.",
            ));
        }
    }
    Ok(())
}

pub(crate) fn download(
    registry: &ModelRegistry,
    spec: &ModelSpec,
    progress: &mut dyn FnMut(Progress),
    cancel: &AtomicBool,
) -> Result<Located, ModelError> {
    let Some(archive) = &spec.archive else {
        return Err(ModelError::new(
            ModelErrorKind::Refused,
            format!(
                "Downloading {} isn't available in this version of Voice.",
                spec.label
            ),
        ));
    };
    let install = registry.own_dir(spec);
    {
        let mut running = RUNNING
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if running.contains(&install) {
            return Err(ModelError::new(
                ModelErrorKind::Busy,
                "This model is already downloading.",
            ));
        }
        running.push(install.clone());
    }
    let _guard = RunningGuard(install.clone());

    if files_present(spec, &install) {
        // Never replace a potentially loaded model, even if its hash is bad.
        return Err(ModelError::new(
            ModelErrorKind::Refused,
            "The model is already downloaded. Switch away and remove it before downloading again.",
        ));
    }
    check_replaceable(spec, &install)?;

    let parent = install
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| registry.own_root());
    fs::create_dir_all(&parent).map_err(ModelError::io)?;
    let needed = archive.size + spec.extracted_size() + SPARE_BYTES;
    if super::disk::free_space(&parent).is_some_and(|free| free < needed) {
        return Err(ModelError::new(
            ModelErrorKind::Disk,
            format!(
                "Not enough disk space. Free at least {:.1} GB for the download and extraction.",
                needed as f64 / 1e9
            ),
        ));
    }

    let temp = parent.join(fsutil::unique_name(".download-", ""));
    fs::create_dir(&temp).map_err(ModelError::io)?;
    let result = install_from(spec, archive, &install, &temp, progress, cancel);
    remove_temp(&registry.own_root(), &temp);
    result?;
    progress(Progress {
        stage: Stage::Installed,
        done: spec.extracted_size(),
        total: Some(spec.extracted_size()),
    });
    Ok(Located {
        dir: install,
        location: Location::Voice,
    })
}

fn install_from(
    spec: &ModelSpec,
    archive: &super::registry::Archive,
    install: &Path,
    temp: &Path,
    progress: &mut dyn FnMut(Progress),
    cancel: &AtomicBool,
) -> Result<(), ModelError> {
    let archive_path = temp.join("model.tar.bz2");
    fetch(archive, &archive_path, progress, cancel)?;

    let staging = temp.join("staging");
    fs::create_dir(&staging).map_err(ModelError::io)?;
    let input = File::open(&archive_path).map_err(ModelError::io)?;
    extract(spec, &archive.root, input, &staging, progress, cancel)?;
    validate(spec, &staging, cancel)?;

    // Swap the finished folder in; put the old one back if the rename fails.
    check_replaceable(spec, install)?;
    let previous = temp.join("previous");
    let had_previous = install.exists();
    if had_previous {
        fs::rename(install, &previous).map_err(ModelError::io)?;
    }
    if let Err(error) = fs::rename(&staging, install) {
        if had_previous {
            let _ = fs::rename(&previous, install);
        }
        return Err(ModelError::io(error));
    }
    Ok(())
}

fn fetch(
    archive: &super::registry::Archive,
    path: &Path,
    progress: &mut dyn FnMut(Progress),
    cancel: &AtomicBool,
) -> Result<(), ModelError> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_connect(Some(NETWORK_TIMEOUT))
        .timeout_per_read(Some(NETWORK_TIMEOUT))
        .user_agent(format!("rukoo-voice/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .into();
    let download_error = |detail: String| {
        ModelError::new(
            ModelErrorKind::Download,
            format!("Couldn't download the model: {detail}"),
        )
    };
    let mut response = agent
        .get(&archive.url)
        .call()
        .map_err(|error| download_error(error.to_string()))?;
    if !response.status().is_success() {
        return Err(download_error(format!(
            "the server answered {}.",
            response.status()
        )));
    }
    let mut body = response
        .body_mut()
        .with_config()
        .limit(archive.size + 1)
        .reader();
    let mut output = fsutil::create_new(path).map_err(ModelError::io)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; BLOCK];
    let mut done = 0u64;
    progress(Progress {
        stage: Stage::Downloading,
        done,
        total: Some(archive.size),
    });
    loop {
        check_cancel(cancel)?;
        let read = match body.read(&mut buffer) {
            Ok(read) => read,
            Err(error) => {
                if done >= archive.size {
                    // The reader refuses to read past its limit: the server sent too much.
                    return Err(archive_error("Model archive exceeds its pinned size."));
                }
                return Err(download_error(error.to_string()));
            }
        };
        if read == 0 {
            break;
        }
        done += read as u64;
        if done > archive.size {
            return Err(archive_error("Model archive exceeds its pinned size."));
        }
        hasher.update(&buffer[..read]);
        output.write_all(&buffer[..read]).map_err(ModelError::io)?;
        progress(Progress {
            stage: Stage::Downloading,
            done,
            total: Some(archive.size),
        });
    }
    output.sync_all().map_err(ModelError::io)?;
    progress(Progress {
        stage: Stage::Verifying,
        done: 0,
        total: None,
    });
    if done != archive.size || hex(&hasher.finalize()) != archive.sha256 {
        return Err(archive_error(
            "Model archive checksum does not match. Try downloading again.",
        ));
    }
    Ok(())
}

/// Extracts a `.tar.bz2` model archive into `staging` with Ownkey's safety rules
/// (`local_models.py:257-288`).
pub fn extract(
    spec: &ModelSpec,
    root: &str,
    archive: impl Read,
    staging: &Path,
    progress: &mut dyn FnMut(Progress),
    cancel: &AtomicBool,
) -> Result<(), ModelError> {
    let decoder = bzip2::read::BzDecoder::new(BufReader::new(archive));
    let mut tar = tar::Archive::new(decoder);
    let total = spec.extracted_size();
    let mut done = 0u64;
    let mut seen = HashSet::new();
    let entries = tar
        .entries()
        .map_err(|_| archive_error("The model archive can't be read."))?;
    for entry in entries {
        check_cancel(cancel)?;
        let mut entry = entry.map_err(|_| archive_error("The model archive can't be read."))?;
        let raw = entry.path_bytes().into_owned();
        let Ok(name) = String::from_utf8(raw) else {
            return Err(archive_error("Unexpected entry in model archive."));
        };
        // Reject absolute paths, drive letters, backslashes and parent references outright.
        if name.contains('\\')
            || name.contains(':')
            || name.starts_with('/')
            || name.split('/').any(|part| part == "..")
        {
            return Err(archive_error("Unsafe path in model archive."));
        }
        let name = name.trim_end_matches('/');
        let kind = entry.header().entry_type();
        if kind.is_dir() && name == root {
            continue;
        }
        // Links, devices and anything else that isn't a plain file are refused.
        let parts: Vec<&str> = name.split('/').collect();
        if !kind.is_file() || parts.len() != 2 || parts[0] != root {
            return Err(archive_error("Unexpected entry in model archive."));
        }
        let file_name = parts[1];
        let pinned = spec.files.iter().find(|file| file.name == file_name);
        let size = entry.header().size().unwrap_or(u64::MAX);
        match pinned {
            Some(file) if file.size == size && !seen.contains(file_name) => {}
            _ => return Err(archive_error(format!("Unexpected model file: {file_name}"))),
        }
        seen.insert(file_name.to_string());
        let mut output = fsutil::create_new(&staging.join(file_name)).map_err(ModelError::io)?;
        let mut buffer = vec![0u8; BLOCK];
        // Copy in blocks so cancel and progress also work inside the 653 MB encoder file.
        loop {
            check_cancel(cancel)?;
            let read = entry
                .read(&mut buffer)
                .map_err(|_| archive_error("The model archive can't be read."))?;
            if read == 0 {
                break;
            }
            output.write_all(&buffer[..read]).map_err(ModelError::io)?;
            done += read as u64;
            progress(Progress {
                stage: Stage::Extracting,
                done,
                total: Some(total),
            });
        }
        output.sync_all().map_err(ModelError::io)?;
    }
    if seen.len() != spec.files.len() {
        return Err(archive_error("The model archive is incomplete."));
    }
    Ok(())
}

/// Removes a temporary download folder, but only one inside Voice's own model folder and never
/// through a link.
fn remove_temp(root: &Path, temp: &PathBuf) {
    if temp.starts_with(root) && temp != root && !is_link(temp) {
        let _ = fs::remove_dir_all(temp);
    }
}
