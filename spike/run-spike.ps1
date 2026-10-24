# 启动一次 OpenCode TUI，验证 CLI 插件加载 / 子进程 / 文件系统 / 重载清理。
# 用法：
#   pwsh -File oc-pet/spike/run-spike.ps1
#   pwsh -File oc-pet/spike/run-spike.ps1 -Reload   # 运行中改 tui.ts，验证 cleanup + 重新 setup
param(
  [switch]$Reload,
  [int]$HoldSeconds = 8
)
$ErrorActionPreference = "Stop"

$spikeDir = $PSScriptRoot
$project = Join-Path $spikeDir "project"
$outDir = Join-Path $spikeDir "out"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$markers = Join-Path $outDir "markers-$stamp.jsonl"
$stdout = Join-Path $outDir "stdout-$stamp.log"
$stderr = Join-Path $outDir "stderr-$stamp.log"

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
Write-Host "[spike] opencode: $opencode"
Write-Host "[spike] markers : $markers"

$proc = Start-Process -FilePath $opencode `
  -ArgumentList @("--print-logs", "--log-level", "debug") `
  -WorkingDirectory $project `
  -RedirectStandardOutput $stdout `
  -RedirectStandardError $stderr `
  -PassThru

Write-Host "[spike] pid: $($proc.Id); waiting for setup..."
$deadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $deadline -and -not (Test-Path $markers)) { Start-Sleep -Milliseconds 250 }

if ($Reload) {
  Start-Sleep -Seconds 1
  $tui = Join-Path $project ".opencode/plugins/oc-pet-spike/tui.ts"
  Add-Content -Path $tui -Value "// reload-test $(Get-Date -Format o)"
  Write-Host "[spike] touched tui.ts, waiting 5s for reconciliation..."
  Start-Sleep -Seconds 5
} else {
  Start-Sleep -Seconds $HoldSeconds
}

if (-not $proc.HasExited) {
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
}

Write-Host "`n=== markers ==="
if (Test-Path $markers) { Get-Content $markers } else { "(none)" }
if (Test-Path ($markers + ".fs-ok")) { Write-Host "fs-ok file: yes" } else { Write-Host "fs-ok file: no" }

Write-Host "`n=== plugin log lines ==="
if (Test-Path $stderr) {
  Select-String -Path $stderr -Pattern 'oc-pet-spike|stage=cleanup|stage=setup' | ForEach-Object { $_.Line } | Select-Object -Last 30
}

Write-Host "`n=== stderr tail ==="
if (Test-Path $stderr) { Get-Content $stderr -Tail 10 }
