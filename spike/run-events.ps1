# 验证 CLI 插件能否收到 OpenCode 服务端事件：
#   1) 起 TUI（插件订阅 data.listen）
#   2) 在同一项目跑一次 `opencode run`（真实会话）
#   3) 检查 markers 里的 event 记录
param(
  [string]$Message = "Reply with exactly: SPIKE_OK",
  [int]$WaitSeconds = 25
)
$ErrorActionPreference = "Stop"

$spikeDir = $PSScriptRoot
$project = Join-Path $spikeDir "project"
$outDir = Join-Path $spikeDir "out"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$markers = Join-Path $outDir "events-$stamp.jsonl"
$stdout = Join-Path $outDir "events-stdout-$stamp.log"
$stderr = Join-Path $outDir "events-stderr-$stamp.log"

$opencode = (Get-Command opencode).Source
if ($opencode -like "*.ps1") {
  $line = Select-String -Path $opencode -Pattern 'node_modules/@opencode/cli/bin/opencode\.exe' | Select-Object -First 1
  if ($line) {
    $rel = [regex]::Match($line.Line, '"([^"]*node_modules[^"]*opencode\.exe)"').Groups[1].Value
    $rel = $rel -replace '^\$basedir', (Split-Path -Parent $opencode)
    $opencode = [System.IO.Path]::GetFullPath($rel)
  }
}

$env:OC_PET_SPIKE_OUT = $markers
Write-Host "[spike] markers : $markers"
$proc = Start-Process -FilePath $opencode `
  -ArgumentList @("--print-logs", "--log-level", "info") `
  -WorkingDirectory $project `
  -RedirectStandardOutput $stdout `
  -RedirectStandardError $stderr `
  -PassThru
Write-Host "[spike] tui pid: $($proc.Id)"

$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
  if (Test-Path $markers) {
    $text = Get-Content $markers -Raw
    if ($text -match '"phase":"listen-ok"') { break }
  }
  Start-Sleep -Milliseconds 300
}
Start-Sleep -Seconds 1

Write-Host "[spike] running: opencode run `"$Message`""
$runOut = Join-Path $outDir "run-$stamp.log"
& $opencode run --auto --format json $Message *> $runOut
Write-Host "[spike] run exit: $LASTEXITCODE"
Write-Host "[spike] waiting $WaitSeconds s for events..."
Start-Sleep -Seconds $WaitSeconds

if (-not $proc.HasExited) {
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
}

Write-Host "`n=== event types ==="
if (Test-Path $markers) {
  Get-Content $markers | Where-Object { $_ -match '"phase":"event"' } | ForEach-Object {
    $j = $_ | ConvertFrom-Json
    "{0,3}  {1}" -f $j.n, $j.type
  }
} else { "(no markers)" }

Write-Host "`n=== non-event markers ==="
if (Test-Path $markers) {
  Get-Content $markers | Where-Object { $_ -notmatch '"phase":"event"' } | ForEach-Object {
    $j = $_ | ConvertFrom-Json
    "{0}  {1}" -f $j.phase, $j.type
  }
}

Write-Host "`n=== run log tail ==="
if (Test-Path $runOut) { Get-Content $runOut -Tail 8 }
