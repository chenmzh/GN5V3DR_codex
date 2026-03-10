$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$startScript = Join-Path $PSScriptRoot 'start-bridge.ps1'
$childPidPath = Join-Path $projectRoot 'bridge-data\logs\bridge.child.pid'
$restartDelaySeconds = 1

Start-Sleep -Seconds $restartDelaySeconds

if (Test-Path $childPidPath) {
    $childProcessId = Get-Content $childPidPath -ErrorAction SilentlyContinue
    if ($childProcessId) {
        $childProcess = Get-Process -Id $childProcessId -ErrorAction SilentlyContinue
        if ($childProcess) {
            Stop-Process -Id $childProcessId -Force
            Write-Output "Bridge child restarted (PID $childProcessId)."
            exit 0
        }
    }
}

& $startScript
