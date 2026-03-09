$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$pidPath = Join-Path $projectRoot 'bridge-data\logs\bridge.pid'

if (-not (Test-Path $pidPath)) {
    Write-Output 'Bridge PID file not found.'
    exit 0
}

$pid = Get-Content $pidPath -ErrorAction SilentlyContinue
if (-not $pid) {
    Remove-Item $pidPath -Force -ErrorAction SilentlyContinue
    Write-Output 'Bridge PID file was empty.'
    exit 0
}

$process = Get-Process -Id $pid -ErrorAction SilentlyContinue
if ($process) {
    Stop-Process -Id $pid -Force
    Write-Output "Bridge stopped (PID $pid)."
} else {
    Write-Output "Bridge process $pid was not running."
}

Remove-Item $pidPath -Force -ErrorAction SilentlyContinue
