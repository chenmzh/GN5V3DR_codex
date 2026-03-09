$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$setupScript = Join-Path $PSScriptRoot 'setup-codex-runtime.ps1'
$logDir = Join-Path $projectRoot 'bridge-data\logs'
$supervisorPidPath = Join-Path $logDir 'bridge.pid'
$childPidPath = Join-Path $logDir 'bridge.child.pid'
$stdoutPath = Join-Path $logDir 'bridge.stdout.log'
$stderrPath = Join-Path $logDir 'bridge.stderr.log'
$stopFlagPath = Join-Path $logDir 'bridge.stop'
$restartDelaySeconds = 5

New-Item -ItemType Directory -Path $logDir -Force | Out-Null
Remove-Item $stopFlagPath -Force -ErrorAction SilentlyContinue

try {
    while ($true) {
        & $setupScript

        $child = Start-Process `
            -FilePath 'node.exe' `
            -ArgumentList 'src/index.js' `
            -WorkingDirectory $projectRoot `
            -RedirectStandardOutput $stdoutPath `
            -RedirectStandardError $stderrPath `
            -PassThru

        Set-Content -Path $childPidPath -Value $child.Id
        Wait-Process -Id $child.Id
        Remove-Item $childPidPath -Force -ErrorAction SilentlyContinue

        if (Test-Path $stopFlagPath) {
            break
        }

        Start-Sleep -Seconds $restartDelaySeconds
    }
}
finally {
    Remove-Item $childPidPath -Force -ErrorAction SilentlyContinue
    Remove-Item $stopFlagPath -Force -ErrorAction SilentlyContinue
}
