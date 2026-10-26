[CmdletBinding(SupportsShouldProcess=$true)]
param([string]$DataDir=(Join-Path $env:LOCALAPPDATA 'RITMIntelligence-Preview'),[string]$TaskName='RITM AI Center')
$ErrorActionPreference='Stop'
$script=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'Open-AICenter.ps1'))
& $script -ResolveOnly | Out-Null
$user=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$action=New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File "'+$script+'" -DataDir "'+[IO.Path]::GetFullPath($DataDir)+'"')
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $user
$settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::FromMinutes(5)) -MultipleInstances IgnoreNew
$principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
if($PSCmdlet.ShouldProcess($TaskName,'Открывать AI Center в Яндекс Браузере один раз при входе Windows')){
  $existing=Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if($existing){if($existing.Description -ne 'RITM Yandex AI Center; logon only; independent of monitoring'){throw 'Existing unrelated task will not be replaced'};Set-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null}
  else {Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'RITM Yandex AI Center; logon only; independent of monitoring' | Out-Null}
}