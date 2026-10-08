[CmdletBinding(SupportsShouldProcess = $true)]
param([string]$DataDir = (Join-Path $env:LOCALAPPDATA 'RITMIntelligence'), [string]$TaskName = 'RITM Intelligence')
$ErrorActionPreference = 'Stop'
$startScript = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'Start-Agent.ps1'))
$launcher = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'Launch-Agent.vbs'))
$resolvedDataDir = [IO.Path]::GetFullPath($DataDir)
if (!(Test-Path -LiteralPath (Join-Path $resolvedDataDir 'owner.secrets.xml'))) { throw 'Сначала выполните Initialize-Agent.ps1.' }
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { throw 'Задача с таким именем уже существует; настройку не заменяем.' }
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$arguments = '"' + $launcher + '" "' + $startScript + '" "' + $resolvedDataDir + '"'
$action = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\wscript.exe') -Argument $arguments -WorkingDirectory ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')))
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
# Repeated trigger recovers even after a clean unexpected exit or exhausted retries.
# IgnoreNew leaves the running process and its ten-minute monitoring loop untouched.
$recoveryTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval ([TimeSpan]::FromMinutes(5))
$settings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval ([TimeSpan]::FromMinutes(2)) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
if ($PSCmdlet.ShouldProcess($TaskName, 'Установить фоновый автозапуск при входе текущего пользователя Windows')) {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($trigger, $recoveryTrigger) -Settings $settings -Principal $principal -Description 'RITM read-only monitoring; owner-protected API; no production writes' | Out-Null
  Write-Output 'Автозапуск установлен. Для запуска сейчас: Start-ScheduledTask -TaskName "RITM Intelligence"'
}
