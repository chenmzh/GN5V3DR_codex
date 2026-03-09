$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$pidPath = Join-Path $projectRoot 'bridge-data\logs\bridge.pid'
$childPidPath = Join-Path $projectRoot 'bridge-data\logs\bridge.child.pid'
$stopFlagPath = Join-Path $projectRoot 'bridge-data\logs\bridge.stop'
$supervisorScript = Join-Path $PSScriptRoot 'supervise-bridge.ps1'

function Test-BridgeSupervisor {
    param (
        [string]$ProcessId,
        [string]$ExpectedScript
    )

    if (-not $ProcessId) {
        return $false
    }

    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    if (-not $process) {
        return $false
    }

    return $process.CommandLine -like "*$ExpectedScript*"
}

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

if (Test-BridgeSupervisor -ProcessId $processId -ExpectedScript $supervisorScript) {
    Stop-Process -Id $processId -Force
    Write-Output "Bridge supervisor stopped (PID $processId)."
} else {
    Write-Output "Bridge supervisor PID $processId did not match the bridge process."
}

Remove-Item $pidPath -Force -ErrorAction SilentlyContinue
Remove-Item $childPidPath -Force -ErrorAction SilentlyContinue
Remove-Item $stopFlagPath -Force -ErrorAction SilentlyContinue
