//! Compiles in the NeMo runtime manifest that `speakers::runtime` checks `nemo_speech\` against:
//! voice/nemo-runtime/manifest.json, or the manifest `RUKOO_VOICE_NEMO_MANIFEST` names. Only
//! `voice/scripts/package.ps1 -RuntimeManifest` sets it, so a test package of a runtime that isn't
//! published yet also accepts the runtime folder it ships.

use std::env;
use std::fs;
use std::path::PathBuf;

const OVERRIDE: &str = "RUKOO_VOICE_NEMO_MANIFEST";

fn main() {
    let crate_dir = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let committed = crate_dir.join("../../nemo-runtime/manifest.json");
    println!("cargo:rerun-if-env-changed={OVERRIDE}");
    let source = match env::var_os(OVERRIDE) {
        Some(path) if !path.is_empty() => PathBuf::from(path),
        _ => committed,
    };
    println!("cargo:rerun-if-changed={}", source.display());
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR")).join("nemo-runtime.json");
    let text = fs::read_to_string(&source)
        .unwrap_or_else(|e| panic!("read the NeMo runtime manifest {}: {e}", source.display()));
    fs::write(&out, text).unwrap_or_else(|e| panic!("write {}: {e}", out.display()));
}
