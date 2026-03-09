$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$pidPath = Join-Path $projectRoot 'bridge-data\logs\bridge.pid'
$childPidPath = Join-Path $projectRoot 'bridge-data\logs\bridge.child.pid'
$stopFlagPath = Join-Path $projectRoot 'bridge-data\logs\bridge.stop'

New-Item -ItemType File -Path $stopFlagPath -Force | Out-Null

if (Test-Path $childPidPath) {
    $childProcessId = Get-Content $childPidPath -ErrorAction SilentlyContinue
    if ($childProcessId) {
        $childProcess = Get-Process -Id $childProcessId -ErrorAction SilentlyContinue
        if ($childProcess) {
            Stop-Process -Id $childProcessId -Force
            Write-Output "Bridge child stopped (PID $childProcessId)."
        }
    }
}

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
    Write-Output "Bridge supervisor stopped (PID $processId)."
} else {
    Write-Output "Bridge process $processId was not running."
}

Remove-Item $pidPath -Force -ErrorAction SilentlyContinue
Remove-Item $childPidPath -Force -ErrorAction SilentlyContinue
Remove-Item $stopFlagPath -Force -ErrorAction SilentlyContinue
