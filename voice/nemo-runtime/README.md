# The NeMo runtime for speaker labels

Voice labels the speakers on a call with NVIDIA Nemotron 3 Diarization, which runs in [NeMo-Speech.cpp](https://github.com/NVIDIA/NeMo-Speech.cpp). The speaker worker, `rukoo-voice-speakers.exe`, loads it from a `nemo_speech\` folder next to itself:

```
nemo_speech\nemo_speech_asr_c.dll, nemo_speech_asr.dll, ggml.dll, ggml-base.dll, ggml-cpu.dll
nemo_speech\msvcp140.dll, vcruntime140.dll, vcruntime140_1.dll
nemo_speech\runtime.json
nemo_speech\licenses\LICENSE, NOTICE, THIRD_PARTY_NOTICES.md, darts-clone.txt
nemo_speech\licenses\vcpkg\abseil.txt, protobuf.txt, sentencepiece.txt, utf8-range.txt
```

The `vcpkg` licenses belong to SentencePiece and the libraries it uses, which vcpkg links statically into `nemo_speech_asr.dll`. NeMo-Speech.cpp's own `THIRD_PARTY_NOTICES.md` names them but doesn't carry their texts. SentencePiece also compiles in Darts-clone, whose BSD license vcpkg doesn't install, so `build.ps1` adds it from `licenses/darts-clone.txt` in this folder.

Voice builds this runtime itself, once per pinned commit, because MSVC builds differ between toolsets: Ownkey's copy and Voice's copy of the same commit have different hashes. The build is portable, an AVX2 baseline with FMA, F16C and BMI2 and no OpenMP, so it runs on any processor that has those four. The Visual C++ runtime ships next to the DLLs, because they use the dynamic C runtime and Voice installs without administrator rights.

| File | What it is |
|---|---|
| `manifest.json` | The pins: commit, submodules, flags and vcpkg. Once the runtime is published, also the archive's URL, size and SHA-256 and the size and SHA-256 of every file in it. |
| `build.ps1` | Builds the runtime folder from source. |
| `pack.ps1` | Checks a built folder, zips it, and writes the filled-in `manifest.json` and the release notes. |
| `licenses/darts-clone.txt` | Darts-clone's license from SentencePiece 0.2.1, unchanged, for the runtime's `licenses\`. |

Who reads `manifest.json`: voice-core compiles it in to check the `nemo_speech\` folder next to the exe before it offers speaker labels; `voice/scripts/package.ps1` downloads the archive, checks every hash and puts the folder into the installer and the portable zip; `voice/scripts/speaker-assets.ps1 -Runtime` fetches it for the tests.

Until the runtime is published, `archive` is `null` and `files` is empty. Then Voice's own runtime never verifies, a development copy uses Ownkey's runtime read only when its five DLLs and the Visual C++ runtime one folder up all match the sizes and hashes of Ownkey's known install, the runtime tests skip, and `package.ps1` stops with "Publish the NeMo runtime first".

## Building it on your computer

You need Git, Visual Studio 2022 with the C++ workload and Python's `py.exe`. CMake and Ninja are installed into a Python environment in the build folder when they are missing.

```powershell
powershell -File voice\nemo-runtime\build.ps1 -Out tmp\nemo\nemo_speech -Jobs 6
```

It clones NeMo-Speech.cpp next to `-Out` unless you pass `-Source`, seeds the portable flags into `CMakeCache.txt`, runs NeMo's `scripts\windows\build.ps1 -Backend cpu -Profile asr`, reads the flags back, checks every DLL's imports with `dumpbin`, copies the Visual C++ runtime from the same Visual Studio install, and writes `runtime.json`. NeMo's script builds SentencePiece with vcpkg under `%LOCALAPPDATA%\NeMoSpeech` the first time, which takes about half an hour; later builds take a few minutes.

To check a build, label the AMI excerpt with it. The commands run from the repository root:

```powershell
powershell -File voice\scripts\speaker-assets.ps1 -Out tmp\speaker-assets -Model -Ami
cargo build --manifest-path voice\Cargo.toml --config voice\.cargo\config.toml --release -p voice-speakers
voice\target\release\rukoo-voice-speakers.exe --self-test --runtime tmp\nemo\nemo_speech --model tmp\speaker-assets\nemotron\Nemotron-3-Diarization.q8_0.gguf --wav tmp\speaker-assets\ami\ami_en2002d_2132.wav
```

Cargo reads `voice\.cargo\config.toml` only when it runs inside `voice\`, so from the root `--config` passes it in. That file links the C runtime into the worker statically, as in the worker Voice ships. Without it the worker imports the Visual C++ runtime itself, and the runtime's DLLs bind to that copy instead of the one in `nemo_speech\`. With `CARGO_TARGET_DIR` set, the exe is under that folder instead of `voice\target`. The self-test should report at least 3 speakers and about 6,000 frames. The runtime tests run against a local build when `RUKOO_VOICE_TEST_NEMO_DIR` points at it and `RUKOO_VOICE_TEST_NEMOTRON` and `RUKOO_VOICE_TEST_AMI` at the files `speaker-assets.ps1` fetched.

## The workflow

`.github/workflows/voice-nemo-runtime.yml` builds the runtime on `windows-2025` whenever a push or pull request changes this folder or the workflow, on any branch, and on a manual dispatch. It runs `build.ps1`, builds the worker, runs the self-test on the AMI excerpt (at least 3 speakers and 5,900 frames), runs `pack.ps1` and uploads the artifact `nemo-runtime-97a15af-1`: the zip, `manifest.json`, `notes.md` and `self-test.json`. It never publishes anything.

## Publishing

Publishing needs the maintainer's approval. It makes the runtime a prerelease of this repository, under a tag that neither update check reads: Rukoo's reads `v` tags and Voice's reads `voice-v` tags, so never tag it either way.

1. Take the artifact of a successful workflow run on the branch that changes the runtime:
   ```powershell
   gh run download <run id> -n nemo-runtime-97a15af-1 -D tmp\nemo-release
   ```
2. Read `self-test.json` and `notes.md`.
3. Publish the zip:
   ```powershell
   gh release create nemo-runtime-97a15af-1 tmp\nemo-release\nemo-runtime-97a15af-1-win-x64.zip --prerelease --latest=false --title "NeMo-Speech.cpp runtime for Rukoo Voice" --notes-file tmp\nemo-release\notes.md
   ```
4. Copy `tmp\nemo-release\manifest.json` over `voice/nemo-runtime/manifest.json` and commit it on the same branch. From then on, CI fetches the runtime and runs the runtime tests instead of skipping them, and a run that couldn't fetch an asset fails rather than passing without them.

A new runtime, for a new NeMo-Speech.cpp commit or a new toolset, gets a new name: change `name` and the pins in `manifest.json`, set `archive` back to `null` and `files` to `[]`, update `NEMO_COMMIT` and `RUNTIME_NAME` in the workflow, and publish under the new name. A published release is never replaced: `package.ps1` on older commits downloads it and checks it against the hashes those commits pinned.
