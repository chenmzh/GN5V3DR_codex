$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$pidPath = Join-Path $projectRoot 'bridge-data\logs\bridge.pid'

if (-not (Test-Path $pidPath)) {
    Write-Output 'Bridge PID file not found.'
    exit 0
}

$processId = Get-Content $pidPath -ErrorAction SilentlyContinue
if (-not $processId) {
    Remove-Item $pidPath -Force -ErrorAction SilentlyContinue
    Write-Output 'Bridge PID file was empty.'
    exit 0
}

$process = Get-Process -Id $processId -ErrorAction SilentlyContinue
if ($process) {
    Stop-Process -Id $processId -Force
    Write-Output "Bridge stopped (PID $processId)."
} else {
    Write-Output "Bridge process $processId was not running."
}

Remove-Item $pidPath -Force -ErrorAction SilentlyContinue
