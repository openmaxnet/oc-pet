# 验证适配层：复用/拉起 daemon、事件联动、cleanup 清状态。
param(
  [switch]$FreshDaemon,
  [int]$HoldSeconds = 10
)
$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$project = Join-Path $PSScriptRoot "project"
$outDir = Join-Path $PSScriptRoot "out"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$stdout = Join-Path $outDir "ocpet-stdout-$stamp.log"
$stderr = Join-Path $outDir "ocpet-stderr-$stamp.log"
$adapterLog = Join-Path $env:USERPROFILE ".dsh\dsh-pet\opencode-adapter.log"
$runtimeFile = Join-Path $env:USERPROFILE ".dsh\dsh-pet\standalone-runtime.json"

$opencode = (Get-Command opencode).Source
if ($opencode -like "*.ps1") {
  $line = Select-String -Path $opencode -Pattern 'node_modules/@opencode/cli/bin/opencode\.exe' | Select-Object -First 1
  if ($line) {
    $rel = [regex]::Match($line.Line, '"([^"]*node_modules[^"]*opencode\.exe)"').Groups[1].Value
    $rel = $rel -replace '^\$basedir', (Split-Path -Parent $opencode)
    $opencode = [System.IO.Path]::GetFullPath($rel)
  }
}

function Get-Runtime {
  if (-not (Test-Path $runtimeFile)) { return $null }
  return Get-Content $runtimeFile -Raw | ConvertFrom-Json
}
function Get-State($rt) {
  if (-not $rt) { return $null }
  return Invoke-RestMethod "http://127.0.0.1:$($rt.port)/dsh-pet-7340/state"
}

if ($FreshDaemon) {
  $rt = Get-Runtime
  if ($rt) {
    Write-Host "[oc-pet] shutting down existing daemon pid=$($rt.pid)..."
    try {
      Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($rt.port)/shutdown" -Headers @{ 'x-dsh-pet-token' = $rt.token } | Out-Null
    } catch {}
    Start-Sleep -Seconds 3
  }
}

Write-Host "[oc-pet] starting TUI..."
$proc = Start-Process -FilePath $opencode -ArgumentList @("--print-logs", "--log-level", "info") `
  -WorkingDirectory $project -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
Write-Host "[oc-pet] tui pid: $($proc.Id)"

$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
  $rt = Get-Runtime
  if ($rt) {
    try {
      $h = Invoke-RestMethod "http://127.0.0.1:$($rt.port)/health" -TimeoutSec 2
      if ($h.ok) { break }
    } catch {}
  }
  Start-Sleep -Milliseconds 500
}
Start-Sleep -Seconds 2
$rt = Get-Runtime
Write-Host "[oc-pet] daemon: pid=$($rt.pid) port=$($rt.port)"
$state = Get-State $rt
Write-Host "[oc-pet] state after setup: $($state.sections.workStatus.data | ConvertTo-Json -Compress)"

Write-Host "[oc-pet] holding $HoldSeconds s..."
Start-Sleep -Seconds $HoldSeconds
$state = Get-State $rt
Write-Host "[oc-pet] state while running: $($state.sections.workStatus.data | ConvertTo-Json -Compress)"

Write-Host "[oc-pet] stopping TUI..."
if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
Start-Sleep -Seconds 3

$rt2 = Get-Runtime
if ($rt2) {
  $state2 = Get-State $rt2
  Write-Host "[oc-pet] state after cleanup: $($state2.sections.workStatus.data | ConvertTo-Json -Compress)"
  Write-Host "[oc-pet] daemon still alive: pid=$($rt2.pid)"
} else {
  Write-Host "[oc-pet] daemon stopped (runtime file gone)"
}

Write-Host "`n=== adapter log (tail) ==="
if (Test-Path $adapterLog) { Get-Content $adapterLog -Tail 30 } else { "(no log)" }
