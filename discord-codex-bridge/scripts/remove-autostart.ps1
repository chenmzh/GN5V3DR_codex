$ErrorActionPreference = 'Stop'

$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'

Remove-ItemProperty -Path $runKey -Name 'DiscordCodexBridge' -ErrorAction SilentlyContinue
Write-Output 'Removed DiscordCodexBridge current-user logon startup entry.'
