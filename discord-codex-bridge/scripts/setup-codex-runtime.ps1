$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $projectRoot 'vendor\codex-runtime'
$sourceDir = 'C:\Program Files\WindowsApps\OpenAI.Codex_26.306.996.0_x64__2p2nqsd0c76g0\app\resources'

New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null

$files = @(
    'codex.exe',
    'codex-command-runner.exe'
)

foreach ($file in $files) {
    $sourcePath = Join-Path $sourceDir $file
    $destPath = Join-Path $runtimeDir $file

    if (-not (Test-Path $sourcePath)) {
        throw "Codex runtime file not found: $sourcePath"
    }

    Copy-Item $sourcePath $destPath -Force
}

Write-Output "Codex runtime refreshed in $runtimeDir"
