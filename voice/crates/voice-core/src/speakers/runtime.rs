//! Where the NeMo-Speech.cpp runtime is: Voice's own copy next to the exe, checked against the
//! committed manifest, or Ownkey's copy when its files match Ownkey's known hashes.

use std::path::{Path, PathBuf};

use serde::Serialize;

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
    pub commit: String,
}

/// voice/nemo-runtime/manifest.json: the files of Voice's own runtime build and their hashes.
#[allow(dead_code)] // Read once runtime verification lands.
pub(crate) const MANIFEST: &str = include_str!("../../../../nemo-runtime/manifest.json");

/// Finds a runtime folder that verifies: the development override, then the folder next to the
/// exe, then Ownkey's. Hashes are cached by path, size and modification time.
pub fn locate_runtime(_exe_dir: &Path, _dev_mode: bool) -> Option<RuntimeInfo> {
    // Placeholder: no runtime verifies until the lookup lands.
    None
}
