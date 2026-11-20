# The NeMo runtime for speaker labels

Voice labels the speakers on a call with NVIDIA Nemotron 3 Diarization, which runs in [NeMo-Speech.cpp](https://github.com/NVIDIA/NeMo-Speech.cpp). The speaker worker, `rukoo-voice-speakers`, loads it from a `nemo_speech` folder next to itself: beside the exe on Windows, and in `Rukoo Voice.app/Contents/Resources/` on macOS. Each platform has its own runtime and its own manifest.

Windows on x86-64:

```
nemo_speech\nemo_speech_asr_c.dll, nemo_speech_asr.dll, ggml.dll, ggml-base.dll, ggml-cpu.dll
nemo_speech\msvcp140.dll, vcruntime140.dll, vcruntime140_1.dll
nemo_speech\runtime.json
nemo_speech\licenses\LICENSE, NOTICE, THIRD_PARTY_NOTICES.md, darts-clone.txt
nemo_speech\licenses\vcpkg\abseil.txt, protobuf.txt, sentencepiece.txt, utf8-range.txt
```

The `vcpkg` licenses belong to SentencePiece and the libraries it uses, which vcpkg links statically into `nemo_speech_asr.dll`. NeMo-Speech.cpp's own `THIRD_PARTY_NOTICES.md` names them but doesn't carry their texts. SentencePiece also compiles in Darts-clone, whose BSD license vcpkg doesn't install, so `build.ps1` adds it from `licenses/darts-clone.txt` in this folder.

macOS on Apple Silicon:

```
nemo_speech/libnemo_speech_asr_c.dylib, libnemo_speech_asr.dylib
nemo_speech/libggml.dylib, libggml-base.dylib, libggml-cpu.dylib, libggml-blas.dylib
nemo_speech/runtime.json
nemo_speech/licenses/LICENSE, NOTICE, THIRD_PARTY_NOTICES.md
nemo_speech/licenses/sentencepiece/LICENSE, absl-LICENSE, darts-clone-LICENSE, protobuf-lite-LICENSE
```

There is no vcpkg on macOS and no Visual C++ runtime: the C++ runtime and libSystem come with macOS, `libggml-blas` and `libggml-cpu` import Accelerate, and SentencePiece is built from source by NeMo's own script, which already stages its four licenses. The six dylibs are 3.8 MB in all.

Voice builds this runtime itself, once per pinned commit, because MSVC builds differ between toolsets: Ownkey's copy and Voice's copy of the same commit have different hashes. The build is portable, an AVX2 baseline with FMA, F16C and BMI2 and no OpenMP, so it runs on any processor that has those four. The Visual C++ runtime ships next to the DLLs, because they use the dynamic C runtime and Voice installs without administrator rights. The macOS build is portable the same way: an ARMv8.2-A baseline with dot-product and FP16 arithmetic, which every Apple Silicon CPU has, no Metal and no OpenMP, and `minos 15.0`. macOS builds from different folders differ too, because the assert strings embed the source path.

| File | What it is |
|---|---|
| `manifest.json` | The pins: commit, submodules, flags and vcpkg. Once the runtime is published, also the archive's URL, size and SHA-256 and the size and SHA-256 of every file in it. |
| `manifest-macos.json` | The macOS pins in the same format, with `target` `macos-aarch64`: commit, submodules, build, flags, toolset and cpu, and once that runtime is published its archive and files. |
| `build.ps1` | Builds the runtime folder from source. |
| `build-macos.sh` | Builds the macOS runtime folder from source. |
| `macos.patch` | The three upstream build-file edits the macOS build needs, applied by `build-macos.sh`. |
| `pack.ps1` | Checks a built folder, zips it, and writes the filled-in `manifest.json` and the release notes. |
| `pack-macos.mjs` | Checks a built macOS folder, signs the six dylibs, zips it reproducibly, and writes the filled-in `manifest-macos.json` and the release notes. |
| `licenses/darts-clone.txt` | Darts-clone's license from SentencePiece 0.2.1, unchanged, for the runtime's `licenses\`. |

Who reads `manifest.json`: voice-core compiles it in to check the `nemo_speech\` folder next to the exe before it offers speaker labels; `voice/scripts/package.ps1` downloads the archive, checks every hash and puts the folder into the installer and the portable zip; `voice/scripts/speaker-assets.ps1 -Runtime` fetches it for the tests. On macOS voice-core compiles in `manifest-macos.json` instead, to check `Contents/Resources/nemo_speech/` in the bundle (or `nemo_speech/` beside an unbundled build), and `voice/scripts/package-macos.mjs` and `voice/scripts/speaker-assets.mjs` read it.

Until the runtime is published, `archive` is `null` and `files` is empty. Then Voice's own runtime never verifies, a development copy uses Ownkey's runtime read only when its five DLLs and the Visual C++ runtime one folder up all match the sizes and hashes of Ownkey's known install, the runtime tests skip, and `package.ps1` stops with "Publish the NeMo runtime first". Both runtimes are published now, as the two assets of the `nemo-runtime-97a15af-1` prerelease. A `manifest-macos.json` in the unpublished state, as for a new runtime name, means this on macOS: Voice's own runtime never verifies on a Mac, a development copy uses `RUKOO_VOICE_NEMO_DIR` (Ownkey never ran on macOS, so there is no copy of its to fall back on), Settings says speaker labels aren't available on macOS yet, and `package-macos.mjs` takes a local build with `--nemo-dir`.

## Building it on Windows

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

## Building it on macOS

You need macOS 15 or later on Apple Silicon, Xcode or its Command Line Tools, git and python3. CMake and Ninja are installed into a Python virtual environment in the build folder when they are missing, as on Windows; no Homebrew and no administrator rights are needed. From the repository root:

```bash
voice/nemo-runtime/build-macos.sh --out tmp/nemo/nemo_speech
```

It refuses a machine that isn't `arm64`, because an Intel build would quietly produce x86_64 dylibs. It clones NeMo-Speech.cpp next to `--out` unless you pass `--source`, checks out the pinned commit and the ggml and llama.cpp submodules from the manifest, and applies `macos.patch`. Then it builds SentencePiece as a static archive with NeMo's own script, configures the `cpu-asr` preset with the manifest's flags, reads them back from `CMakeCache.txt` as `build.ps1` does, and stages the flat dylibs. Finally it checks every one: arm64, `minos 15.0`, and importing only libSystem, libc++, Accelerate and the other dylibs of the folder. A build takes under a minute on an M4.

The first run on a machine whose Command Line Tools SDK is newer than Xcode's linker fails every link with `tapi error: malformed file`; the script probes `clang` and falls back to the SDK inside Xcode by exporting `SDKROOT`, which changes nothing system-wide.

Then label the excerpt, from `voice/`:

```bash
node scripts/speaker-assets.mjs --out tmp/speaker-assets --model --ami
cargo build --release -p voice-speakers
target/release/rukoo-voice-speakers --self-test --runtime tmp/nemo/nemo_speech --model tmp/speaker-assets/nemotron/Nemotron-3-Diarization.q8_0.gguf --wav tmp/speaker-assets/ami/ami_en2002d_2132.wav
```

The self-test should report at least 3 speakers and about 6,000 frames; on an M4 it runs at about 26 times real time. `node scripts/speaker-assets.mjs --out tmp/speaker-assets --nemo-dir tmp/nemo/nemo_speech` checks a local build against `manifest-macos.json` and prints the three variables the runtime tests read, which works before the macOS runtime is published.

## Signing it on macOS

A hardened program refuses to load a dylib that another team signed. Ad-hoc signatures have no Team ID, so macOS derives one from each signature and every ad-hoc signature is a different team: `dlopen` fails with "mapping process and mapped file (non-platform) have different Team IDs". That is why `rukoo-voice-speakers` carries `com.apple.security.cs.disable-library-validation`, and nothing else in Voice does. Packaging signs the six dylibs before the worker, unless a dylib already carries the packed signature — ad-hoc (`codesign -s - --force -o runtime`), or with the Developer ID when there is one — then the worker, then the app, which is also the order `codesign --verify --deep --strict` expects. A hardened process also refuses a relative `dlopen` path, which the worker never uses: it resolves the folder to an absolute path first.

The folder ships in `Rukoo Voice.app/Contents/Resources/nemo_speech/`, not under `Contents/Frameworks/`: codesign reads a folder under `Frameworks` as nested code and refuses the licences and `runtime.json`, which aren't code. Voice's lookup knows that path (`voice-core`'s `speakers::runtime`), and still tries `nemo_speech/` beside the exe for an unbundled build.

The runtime folder as `build-macos.sh` writes it is unsigned, or only linker-signed; signing changes its hashes, so it happens at packaging time and `manifest-macos.json` pins the signed files.

`pack-macos.mjs` signs the six dylibs ad-hoc with hardened runtime, no identifier override and no entitlements (`codesign --force --sign - --options runtime --timestamp=none`), and `voice/scripts/package-macos.mjs` gives a NeMo dylib exactly that signature. An ad-hoc signature has no timestamp and takes its identifier from the file name, so it is deterministic: signing the same bytes under the same name twice, in two folders or on two machines, gives the same file. `package-macos.mjs` leaves a dylib in that state alone instead of signing it again, then checks the app's folder against `manifest-macos.json` again after signing and refuses to write the DMG and the zip if a file changed, so the dylibs inside a finished `Rukoo Voice.app` are the pinned files and voice-core's `verify_voice` accepts the folder it ships.

A `--developer-id` package is refused while the runtime comes from the pinned archive: it re-signs every dylib with the Developer ID, which changes their hashes, and no ad-hoc `manifest-macos.json` pins those. A notarized package needs a runtime packed with that identity and a manifest that pins its files; publishing such a runtime under a new name is how that would happen.

## Packing it on macOS

`pack-macos.mjs` is the counterpart of `pack.ps1`. Run it on the folder `build-macos.sh` wrote, after the smoke test, and nowhere else needs to sign anything:

```bash
node voice/nemo-runtime/pack-macos.mjs --runtime tmp/nemo/nemo_speech --out tmp/nemo/release
```

It refuses a folder whose `runtime.json` names another target (a Windows folder belongs to `pack.ps1`) or another build, checks every file in the folder against `runtime.json` and refuses one it doesn't list, signs copies of the six dylibs, rewrites the copied `runtime.json` for the signed files, and writes three files to `--out`:

- `<name>-macos-arm64.zip`: the folder's files at the top of the archive, so it unpacks to `nemo_speech/`. Entries are sorted and dated 1980-01-01 00:00:00, the dylibs have Unix mode 0755 and the rest 0644, so the same input and the same Node version give the same zip; another zlib version could compress differently, and the published hashes pin the archive that was built.
- `manifest-macos.json`: the committed macOS manifest with the archive's URL, size and SHA-256 and every file's size and hash filled in. It never writes `manifest.json`, the Windows manifest.
- `notes.md`: the release notes, with the source, flags, toolset, signature, licenses and every hash.

`--repository` names the GitHub repository the archive URL points at, `MajesteitBart/rukoo` unless given.

## The workflow

`.github/workflows/voice-nemo-runtime.yml` builds the runtime on `windows-2025` whenever a push or pull request changes this folder, apart from the macOS runtime's four files, or the workflow, on any branch, and on a manual dispatch. It runs `build.ps1`, builds the worker, runs the self-test on the AMI excerpt (at least 3 speakers and 5,900 frames), runs `pack.ps1` and uploads the artifact `nemo-runtime-97a15af-1`: the zip, `manifest.json`, `notes.md` and `self-test.json`. It never publishes anything.

`.github/workflows/voice-nemo-runtime-macos.yml` builds the macOS runtime on `macos-15` when a push or pull request changes `manifest-macos.json`, `build-macos.sh`, `macos.patch`, `pack-macos.mjs` or that workflow, and on a manual dispatch; the Windows workflow leaves those four files out of its paths. It runs `build-macos.sh` from a fixed checkout path (`$RUNNER_TEMP/nemo/NeMo-Speech.cpp`, because the source path ends up in the dylibs), builds the worker, fetches the model and the AMI excerpt with `speaker-assets.mjs`, runs the same self-test against the fresh runtime, runs `pack-macos.mjs`, unpacks the zip and runs the self-test again against the signed dylibs, and uploads the artifact `nemo-runtime-97a15af-1-macos-arm64`: the zip, `manifest-macos.json`, `notes.md`, `self-test.json` and `self-test-packed.json`. It never publishes anything either.

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

### The macOS runtime

The macOS zip is one more asset of the same prerelease, published the same way and with the same approval:

1. Take the artifact of a successful `voice-nemo-runtime-macos.yml` run on `main`, after the change to the runtime merged (start one by hand when the merge didn't):
   ```bash
   gh run download <run id> -n nemo-runtime-97a15af-1-macos-arm64 -D tmp/nemo-macos-release
   ```
2. Read `self-test.json`, `self-test-packed.json` and `notes.md`.
3. Add the zip to the existing prerelease. No `--clobber`: a published asset is never replaced.
   ```bash
   gh release upload nemo-runtime-97a15af-1 tmp/nemo-macos-release/nemo-runtime-97a15af-1-macos-arm64.zip
   ```
4. Copy `tmp/nemo-macos-release/manifest-macos.json` over `voice/nemo-runtime/manifest-macos.json` and commit it in a PR. From then on macOS CI fetches the runtime and runs the runtime tests instead of skipping them, and `package-macos.mjs` downloads the macOS archive.

The workflow already signs, zips and writes the manifest, so the maintainer only downloads the artifact, reads the reports, uploads the zip and copies the manifest over. Do not build a runtime with `build-macos.sh` and publish that: its bytes differ from the pinned ones, and `package-macos.mjs` checks the archive against the pins. A new runtime name changes `name` and the pins in `manifest-macos.json` too, with its `archive` back to `null` and `files` to `[]`, and `RUNTIME_NAME` in `voice-nemo-runtime-macos.yml`.
