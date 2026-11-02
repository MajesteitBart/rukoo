<#
.SYNOPSIS
Samples the CPU and GPU use of a few processes once a second, for Rukoo Voice's measurements.

.DESCRIPTION
voice/scripts/live-meeting.mjs --measure=screen starts it during a meeting with live transcription; it also runs on
its own. It only reads: it never starts, stops or changes a process.

Per process, every second:
  - CPU as a percentage of one core, from the change in (Get-Process -Id).TotalProcessorTime.
  - GPU per engine type (3D, Copy, VideoEncode, VideoDecode, VideoProcessing and the rest), the sum of
    \GPU Engine(pid_<pid>_*)\Utilization Percentage over that process's engines of the type.
And for the machine: CPU of all cores from Win32_PerfFormattedData_PerfOS_Processor (_Total), whose names don't
depend on the Windows language, and GPU per engine type over every process. "GPU Engine" keeps its English name on
localized Windows.

The JSON at -Out holds every sample and a summary: mean, p95 and max per process and for the machine.

.EXAMPLE
powershell -File voice\scripts\measure.ps1 -Pids 1200,1388 -Names rukoo-voice,screen -Seconds 600 -Out tmp\measure.json
#>
param(
    [Parameter(Mandatory = $true)][string]$Pids,
    [string]$Names = '',
    [int]$Seconds = 600,
    [Parameter(Mandatory = $true)][string]$Out
)

$ErrorActionPreference = 'Stop'

$pidList = @($Pids -split ',' | Where-Object { $_ } | ForEach-Object { [int]$_ })
$nameList = @($Names -split ',' | Where-Object { $_ })
$label = @{}
for ($i = 0; $i -lt $pidList.Count; $i++) {
    $label[$pidList[$i]] = if ($i -lt $nameList.Count) { $nameList[$i] } else { "pid-$($pidList[$i])" }
}

function Cpu-Ms([int]$id) {
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($p) { return $p.TotalProcessorTime.TotalMilliseconds }
    return $null
}

function Stats([double[]]$values) {
    if (-not $values -or $values.Count -eq 0) { return [ordered]@{ mean = $null; p95 = $null; max = $null } }
    $sorted = $values | Sort-Object
    $index = [Math]::Min($sorted.Count - 1, [Math]::Ceiling(0.95 * $sorted.Count) - 1)
    return [ordered]@{
        mean = [Math]::Round(($values | Measure-Object -Average).Average, 1)
        p95 = [Math]::Round($sorted[$index], 1)
        max = [Math]::Round(($values | Measure-Object -Maximum).Maximum, 1)
    }
}

$previous = @{}
$clock = [Diagnostics.Stopwatch]::StartNew()
$last = $null
$first = 0.0
$samples = New-Object System.Collections.Generic.List[object]
$pattern = '^pid_(\d+)_.*_engtype_(.+)$'
$done = 'measure.ps1: enough samples'

# Get-Counter expands the wildcard once, which takes a while, and each sample takes a little over a second to read.
# The first sample is the baseline; sampling stops once -Seconds have passed since it.
try {
Get-Counter -Counter '\GPU Engine(*)\Utilization Percentage' -SampleInterval 1 -Continuous -ErrorAction SilentlyContinue | ForEach-Object {
    $now = $clock.Elapsed.TotalMilliseconds
    if ($null -eq $last) {
        foreach ($id in $pidList) { $previous[$id] = Cpu-Ms $id }
        $last = $now
        $first = $now
        return
    }
    $elapsed = $now - $last
    $last = $now

    $cpu = [ordered]@{}
    foreach ($id in $pidList) {
        $ms = Cpu-Ms $id
        if ($null -ne $ms -and $null -ne $previous[$id] -and $elapsed -gt 0) {
            $cpu[$label[$id]] = [Math]::Round(($ms - $previous[$id]) / $elapsed * 100, 2)
        } else {
            $cpu[$label[$id]] = $null
        }
        $previous[$id] = $ms
    }

    $gpu = @{}
    $all = @{}
    foreach ($s in $_.CounterSamples) {
        if (-not ($s.InstanceName -match $pattern)) { continue }
        $owner = [int]$Matches[1]
        $engine = $Matches[2]
        $all[$engine] = [double]($all[$engine]) + $s.CookedValue
        if ($label.ContainsKey($owner)) {
            $name = $label[$owner]
            if (-not $gpu.ContainsKey($name)) { $gpu[$name] = @{} }
            $gpu[$name][$engine] = [double]($gpu[$name][$engine]) + $s.CookedValue
        }
    }

    $total = (Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'").PercentProcessorTime
    $samples.Add([ordered]@{ t = [Math]::Round(($now - $first) / 1000, 2); cpu = $cpu; total = $total; gpu = $gpu; gpuAll = $all })
    if ($now - $first -ge $Seconds * 1000) { throw $done }
}
} catch {
    if ("$_" -ne $done) { throw }
}

$summary = [ordered]@{ samples = $samples.Count; seconds = $(if ($samples.Count) { $samples[$samples.Count - 1].t } else { 0 }); cores = [Environment]::ProcessorCount; processes = [ordered]@{}; total = $null; gpuAll = [ordered]@{} }
foreach ($id in $pidList) {
    $name = $label[$id]
    $values = @($samples | ForEach-Object { $_.cpu[$name] } | Where-Object { $null -ne $_ })
    $engines = @($samples | ForEach-Object { if ($_.gpu.ContainsKey($name)) { $_.gpu[$name].Keys } } | Sort-Object -Unique)
    $perEngine = [ordered]@{}
    foreach ($engine in $engines) {
        $perEngine[$engine] = Stats @($samples | ForEach-Object { if ($_.gpu.ContainsKey($name) -and $_.gpu[$name].ContainsKey($engine)) { $_.gpu[$name][$engine] } else { 0 } })
    }
    $summary.processes[$name] = [ordered]@{ pid = $id; cpu = Stats $values; gpu = $perEngine }
}
$summary.total = Stats @($samples | ForEach-Object { [double]$_.total })
foreach ($engine in @($samples | ForEach-Object { $_.gpuAll.Keys } | Sort-Object -Unique)) {
    $summary.gpuAll[$engine] = Stats @($samples | ForEach-Object { if ($_.gpuAll.ContainsKey($engine)) { $_.gpuAll[$engine] } else { 0 } })
}

$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
$pidByName = [ordered]@{}
foreach ($id in $pidList) { $pidByName[$label[$id]] = $id }
$json = [ordered]@{ pids = $pidByName; summary = $summary; samples = $samples } | ConvertTo-Json -Depth 8
# UTF-8 without the byte order mark that Windows PowerShell's -Encoding utf8 writes, so JSON readers take it.
[IO.File]::WriteAllText([IO.Path]::GetFullPath($Out), $json, (New-Object Text.UTF8Encoding $false))
Write-Host "measure.ps1: $($samples.Count) samples in $Out"
