$ErrorActionPreference = 'Stop'

$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$projectRoot = Split-Path -Parent $PSScriptRoot
$startScript = Join-Path $PSScriptRoot 'start-bridge.ps1'
$command = "powershell.exe -ExecutionPolicy Bypass -File `"$startScript`""

New-Item -Path $runKey -Force | Out-Null
Set-ItemProperty -Path $runKey -Name 'DiscordCodexBridge' -Value $command

Write-Output 'Registered DiscordCodexBridge for current-user logon startup.'
Write-Output $command
