<#
.SYNOPSIS
Packs a built NeMo runtime folder into the release zip and writes the manifest that pins it.

.DESCRIPTION
Checks the folder build.ps1 wrote against its runtime.json (every file present with its size and SHA-256, nothing
else), zips it as <name>-win-x64.zip with the files at the top of the archive, and writes two files next to it:
manifest.json, which is runtime.json plus the archive's download URL, size and SHA-256, and notes.md, the release notes
with the source, flags, toolset, licenses and every hash. After the zip is published as the release asset, that
manifest.json replaces voice/nemo-runtime/manifest.json (README.md, "Publishing").

.PARAMETER Runtime
The runtime folder build.ps1 wrote.

.PARAMETER Out
Where the zip and manifest.json go.

.PARAMETER Repository
The GitHub repository the release belongs to.

.EXAMPLE
powershell -File voice\nemo-runtime\pack.ps1 -Runtime tmp\nemo\nemo_speech -Out tmp\nemo\release
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Runtime,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Repository = 'MajesteitBart/rukoo'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$Utf8 = New-Object System.Text.UTF8Encoding($false)

function Resolve-Full {
  param([string]$Path)
  if (-not [IO.Path]::IsPathRooted($Path)) { $Path = Join-Path (Get-Location).Path $Path }
  return [IO.Path]::GetFullPath($Path)
}

function Get-Sha256 {
  param([string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

$Runtime = Resolve-Full $Runtime
$Out = Resolve-Full $Out
$pins = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') -Raw | ConvertFrom-Json
$runtimeJson = Join-Path $Runtime 'runtime.json'
if (-not (Test-Path -LiteralPath $runtimeJson)) { throw "$Runtime has no runtime.json; build it with build.ps1" }
$built = Get-Content -LiteralPath $runtimeJson -Raw | ConvertFrom-Json
if ($built.name -ne $pins.name -or $built.commit -ne $pins.commit) {
  throw "$Runtime holds $($built.name) at $($built.commit), not $($pins.name) at $($pins.commit)"
}

$paths = @('runtime.json')
foreach ($file in $built.files) {
  $full = Join-Path $Runtime $file.path
  if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw "$($file.path) is missing from $Runtime" }
  if ((Get-Item -LiteralPath $full).Length -ne $file.size -or (Get-Sha256 $full) -ne $file.sha256) {
    throw "$($file.path) differs from runtime.json"
  }
  $paths += $file.path
}
$present = @(Get-ChildItem -LiteralPath $Runtime -Recurse -File | ForEach-Object { $_.FullName.Substring($Runtime.Length + 1).Replace('\', '/') })
$extra = @($present | Where-Object { $paths -notcontains $_ })
if ($extra.Count -gt 0) { throw "$Runtime also holds $($extra -join ', '), which runtime.json doesn't list" }

New-Item -ItemType Directory -Force -Path $Out | Out-Null
$zipName = "$($pins.name)-win-x64.zip"
$zipPath = Join-Path $Out $zipName
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
# Entry names use forward slashes, which every unzip tool reads; Compress-Archive in Windows PowerShell writes
# backslashes.
$zip = [IO.Compression.ZipFile]::Open($zipPath, [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($path in ($paths | Sort-Object)) {
    [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $Runtime $path), $path, [IO.Compression.CompressionLevel]::Optimal)
  }
} finally { $zip.Dispose() }

$manifest = [ordered]@{}
foreach ($property in $built.PSObject.Properties) {
  if ($property.Name -eq 'files') {
    $manifest['archive'] = [ordered]@{
      url = "https://github.com/$Repository/releases/download/$($pins.name)/$zipName"
      size = (Get-Item -LiteralPath $zipPath).Length
      sha256 = Get-Sha256 $zipPath
    }
  }
  $manifest[$property.Name] = $property.Value
}
$json = ($manifest | ConvertTo-Json -Depth 6).Replace("`r`n", "`n")
[IO.File]::WriteAllText((Join-Path $Out 'manifest.json'), $json + "`n", $Utf8)

# The release notes: what was built, from which source, with which toolset, under which licenses, and every hash.
$short = $built.commit.Substring(0, 7)
$flags = ($built.flags.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ', '
$notes = New-Object System.Text.StringBuilder
[void]$notes.Append("The NeMo-Speech.cpp runtime that Rukoo Voice's speaker worker, ``rukoo-voice-speakers.exe``, loads from its ``nemo_speech\`` folder to label speakers with NVIDIA Nemotron 3 Diarization. It is not a release of Rukoo or Rukoo Voice; Voice's installer carries these files, and ``voice/nemo-runtime/manifest.json`` pins them.`n`n")
[void]$notes.Append("- Source: [NVIDIA/NeMo-Speech.cpp](https://github.com/NVIDIA/NeMo-Speech.cpp) at [``$short``](https://github.com/NVIDIA/NeMo-Speech.cpp/commit/$($built.commit)), with ggml at ``$($built.submodules.ggml)`` and llama.cpp at ``$($built.submodules.'llama.cpp')``.`n")
[void]$notes.Append("- Build: $($built.build). ggml flags: $flags.`n")
$crtVersion = ($built.files | Where-Object { $_.path -eq 'msvcp140.dll' } | Select-Object -First 1).version
[void]$notes.Append("- Toolset: $($built.toolset.runner), MSVC $($built.toolset.msvc), Visual C++ runtime $crtVersion; vcpkg $($built.vcpkg.tag), triplet ``$($built.vcpkg.triplet)``.`n")
$features = @($built.cpu | ForEach-Object { $_.ToUpperInvariant() })
$featureText = $features[-1]
if ($features.Count -gt 1) { $featureText = ($features[0..($features.Count - 2)] -join ', ') + ' and ' + $features[-1] }
[void]$notes.Append("- Needs a 64-bit processor with $featureText.`n")
$linked = @($built.files | Where-Object { $_.path -like 'licenses/vcpkg/*' } | ForEach-Object { [IO.Path]::GetFileNameWithoutExtension($_.path) })
[void]$notes.Append("- Licenses: NeMo-Speech.cpp is Apache-2.0, Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. ``licenses\LICENSE``, ``licenses\NOTICE`` and ``licenses\THIRD_PARTY_NOTICES.md`` come with it and name what the DLLs contain, such as ggml (MIT). ``licenses\darts-clone.txt`` is the BSD 2-Clause license of Darts-clone, which SentencePiece compiles in. ``licenses\vcpkg\`` holds the licenses of the libraries vcpkg linked in: $($linked -join ', '). ``msvcp140.dll``, ``vcruntime140.dll`` and ``vcruntime140_1.dll`` are unmodified Microsoft Visual C++ runtime files, redistributed under the Visual Studio license terms.`n`n")
[void]$notes.Append("| File | Bytes | SHA-256 |`n|---|---:|---|`n")
[void]$notes.Append("| ``$zipName`` | $($manifest.archive.size) | ``$($manifest.archive.sha256)`` |`n")
foreach ($file in $built.files) {
  $version = ''
  if ($file.PSObject.Properties['version']) { $version = " (version $($file.version))" }
  [void]$notes.Append("| ``$($file.path)``$version | $($file.size) | ``$($file.sha256)`` |`n")
}
[IO.File]::WriteAllText((Join-Path $Out 'notes.md'), $notes.ToString(), $Utf8)

Write-Host "Packed $zipName ($('{0:N0}' -f $manifest.archive.size) bytes, SHA-256 $($manifest.archive.sha256))"
Write-Host "Wrote manifest.json and notes.md in $Out"
