$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $projectRoot 'bridge-data\logs'
$supervisorPidPath = Join-Path $logDir 'bridge.pid'
$supervisorScript = Join-Path $PSScriptRoot 'supervise-bridge.ps1'

New-Item -ItemType Directory -Path $logDir -Force | Out-Null

if (Test-Path $supervisorPidPath) {
    $existingPid = Get-Content $supervisorPidPath -ErrorAction SilentlyContinue
    if ($existingPid) {
        $running = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
        if ($running) {
            Write-Output "Bridge supervisor is already running with PID $existingPid."
            exit 0
        }
    }
}

$supervisor = Start-Process `
    -FilePath 'powershell.exe' `
    -ArgumentList @(
        '-ExecutionPolicy', 'Bypass',
        '-File', "`"$supervisorScript`""
    ) `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -PassThru

Set-Content -Path $supervisorPidPath -Value $supervisor.Id
Start-Sleep -Seconds 2
Write-Output "Bridge launcher started supervisor PID $($supervisor.Id)."
