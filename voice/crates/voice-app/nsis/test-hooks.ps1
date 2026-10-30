<#
.SYNOPSIS
Tests hooks.nsh without installing anything.

.DESCRIPTION
Compiles a small NSIS program that includes hooks.nsh and runs it silently. It checks that:
  - the folder the directory page offers moves out of Voice's data folder (%LOCALAPPDATA%\Rukoo Voice) to
    %LOCALAPPDATA%\Programs\Rukoo Voice, and that any other folder stays as chosen;
  - the installer stops while a rukoo-voice-recorder.exe runs from the install folder, and goes on once it has quit.
For the second check it starts the recorder from a scratch folder with a synthetic tone, and stops it by its own
process handle. The test only reads %LOCALAPPDATA%; it writes under -Work.

package.ps1 runs it after the bundler has put NSIS in %LOCALAPPDATA%\tauri\NSIS.
#>
[CmdletBinding()]
param(
  [string]$MakeNsis = (Join-Path $env:LOCALAPPDATA 'tauri\NSIS\makensis.exe'),
  [Parameter(Mandatory = $true)][string]$Recorder,
  [Parameter(Mandatory = $true)][string]$Work
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

if (-not (Test-Path -LiteralPath $MakeNsis)) { throw "makensis not found at $MakeNsis" }
if (Test-Path -LiteralPath $Work) { Remove-Item -LiteralPath $Work -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Work | Out-Null
$hooks = Join-Path $PSScriptRoot 'hooks.nsh'
$exe = Join-Path $Work 'hooks-test.exe'

$script = @'
Unicode true
Name "Rukoo Voice hooks test"
OutFile "${OUT_EXE}"
RequestExecutionLevel user
SilentInstall silent
!include LogicLib.nsh
!include FileFunc.nsh
!include "Win\RestartManager.nsh"
LoadLanguageFile "${NSISDIR}\Contrib\Language files\English.nlf"
!include "${HOOKS}"
LangString voiceKeepsData ${LANG_ENGLISH} "keeps data"
LangString voiceMovedInstall ${LANG_ENGLISH} "moved"
LangString voiceRecordingInstall ${LANG_ENGLISH} "recording"
LangString voiceRecordingUninstall ${LANG_ENGLISH} "recording"

!macro Offer from key
  StrCpy $INSTDIR "${from}"
  Call VoiceOfferProgramsFolder
  FileWrite $9 "${key}=$INSTDIR$\r$\n"
!macroend

Section
  ${GetParameters} $R0
  ${GetOptions} $R0 "/OUT=" $R1
  ${GetOptions} $R0 "/DIR=" $R2
  SetShellVarContext current
  FileOpen $9 $R1 w
  !insertmacro Offer "$LOCALAPPDATA\Rukoo Voice" data
  !insertmacro Offer "$LOCALAPPDATA\RUKOO VOICE" data-upper
  !insertmacro Offer "$LOCALAPPDATA\Programs\Rukoo Voice" programs
  !insertmacro Offer "D:\Apps\Rukoo Voice" other
  FileWrite $9 "localappdata=$LOCALAPPDATA$\r$\n"
  FileClose $9
  StrCpy $INSTDIR $R2
  !insertmacro VOICE_REFUSE_WHILE_RECORDING "$(voiceRecordingInstall)"
  FileOpen $9 $R1 a
  FileSeek $9 0 END
  FileWrite $9 "went-on=yes$\r$\n"
  FileClose $9
SectionEnd
'@
$nsi = Join-Path $Work 'hooks-test.nsi'
[IO.File]::WriteAllText($nsi, $script, (New-Object System.Text.UTF8Encoding($true)))
& $MakeNsis /V2 "/DHOOKS=$hooks" "/DOUT_EXE=$exe" $nsi
if ($LASTEXITCODE -ne 0) { throw "makensis failed with exit code $LASTEXITCODE" }

function Invoke-Test {
  param([string]$Name, [string]$Dir)
  $out = Join-Path $Work "$Name.txt"
  $p = Start-Process -FilePath $exe -ArgumentList @('/S', "/OUT=$out", "/DIR=$Dir") -PassThru -Wait
  $values = @{}
  foreach ($line in [IO.File]::ReadAllLines($out)) {
    $pair = $line -split '=', 2
    $values[$pair[0]] = $pair[1]
  }
  return New-Object PSObject -Property @{ Exit = $p.ExitCode; Values = $values }
}

$failures = @()
function Expect {
  param([string]$What, $Actual, $Wanted)
  if ($Actual -ceq $Wanted) { Write-Host "  ok    $What" }
  else {
    Write-Host "  FAIL  $What`: got '$Actual', wanted '$Wanted'"
    $script:failures += $What
  }
}

Write-Host 'Install folder, and an install folder without a recorder'
$empty = Join-Path $Work 'install-empty'
New-Item -ItemType Directory -Force -Path $empty | Out-Null
$r = Invoke-Test 'empty' $empty
$local = $r.Values['localappdata']
Expect 'the data folder moves to Programs' $r.Values['data'] "$local\Programs\Rukoo Voice"
Expect 'the data folder in capitals moves too' $r.Values['data-upper'] "$local\Programs\Rukoo Voice"
Expect 'the Programs folder stays' $r.Values['programs'] "$local\Programs\Rukoo Voice"
Expect 'another folder stays' $r.Values['other'] 'D:\Apps\Rukoo Voice'
Expect 'it goes on without a recorder' $r.Values['went-on'] 'yes'
Expect 'exit code without a recorder' $r.Exit 0

Write-Host 'A recorder running from the install folder'
$install = Join-Path $Work 'install-recording'
$meeting = Join-Path $Work 'meeting'
New-Item -ItemType Directory -Force -Path $install, $meeting | Out-Null
$copy = Join-Path $install 'rukoo-voice-recorder.exe'
Copy-Item -LiteralPath $Recorder -Destination $copy
$running = Start-Process -FilePath $copy -ArgumentList @('record', '--meeting', "`"$meeting`"", '--track', 'mic=synthetic:tone:440') `
  -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $Work 'recorder.out') -RedirectStandardError (Join-Path $Work 'recorder.err')
try {
  $deadline = (Get-Date).AddSeconds(15)
  while (-not (Test-Path -LiteralPath (Join-Path $meeting 'recorder.json'))) {
    if ($running.HasExited) { throw "The recorder quit with exit code $($running.ExitCode)" }
    if ((Get-Date) -gt $deadline) { throw 'The recorder did not start within 15 s' }
    Start-Sleep -Milliseconds 100
  }
  $r = Invoke-Test 'recording' $install
  Expect 'it stops while the recorder runs' $r.Values.ContainsKey('went-on') $false
  Expect 'exit code while the recorder runs (NSIS abort)' $r.Exit 2
  Expect 'the recorder still runs' $running.HasExited $false
} finally {
  if (-not $running.HasExited) { $running.Kill() }
  $running.WaitForExit()
}
$r = Invoke-Test 'stopped' $install
Expect 'it goes on once the recorder has quit' $r.Values['went-on'] 'yes'
Expect 'exit code after the recorder quit' $r.Exit 0

if ($failures.Count -gt 0) { throw "$($failures.Count) hooks.nsh checks failed" }
Write-Host 'hooks.nsh: all checks passed'
