$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $projectRoot 'bridge-data\logs'
$pidPath = Join-Path $logDir 'bridge.pid'
$stdoutPath = Join-Path $logDir 'bridge.stdout.log'
$stderrPath = Join-Path $logDir 'bridge.stderr.log'

New-Item -ItemType Directory -Path $logDir -Force | Out-Null

if (Test-Path $pidPath) {
    $existingPid = Get-Content $pidPath -ErrorAction SilentlyContinue
    if ($existingPid) {
        $running = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
        if ($running) {
            Write-Output "Bridge is already running with PID $existingPid."
            exit 0
        }
    }
}

$process = Start-Process `
    -FilePath 'node.exe' `
    -ArgumentList 'src/index.js' `
    -WorkingDirectory $projectRoot `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru

Set-Content -Path $pidPath -Value $process.Id
Write-Output "Bridge started with PID $($process.Id)."
Write-Output "Stdout: $stdoutPath"
Write-Output "Stderr: $stderrPath"
