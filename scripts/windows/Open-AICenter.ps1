[CmdletBinding()]
param([switch]$ResolveOnly, [int]$DebugPort = 0, [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'RITMIntelligence-Preview'))
$ErrorActionPreference='Stop'
$candidates=@()
foreach($key in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\browser.exe','HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\browser.exe','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\browser.exe')) {
  $entry=Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue
  if($entry){$candidates+=$entry.'(default)'}
}
foreach($root in @('HKCU:\Software\Clients\StartMenuInternet','HKLM:\Software\Clients\StartMenuInternet')) {
  foreach($entry in Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue) {
    if($entry.PSChildName -like '*Yandex*') {
      $command=(Get-ItemProperty -LiteralPath (Join-Path $entry.PSPath 'shell\open\command') -ErrorAction SilentlyContinue).'(default)'
      if($command -match '^"([^"]+\.exe)"'){$candidates+=$Matches[1]}
    }
  }
}
$browser=$candidates | Where-Object {$_ -and (Test-Path -LiteralPath $_ -PathType Leaf)} | Where-Object {(Get-Item -LiteralPath $_).VersionInfo.ProductName -match 'Yandex'} | Select-Object -First 1
if(!$browser){throw 'Установленный Яндекс Браузер не найден в регистрации Windows.'}
if($ResolveOnly){Write-Output $browser;return}
$ready=$false
for($attempt=0;$attempt -lt 90;$attempt++) {
  try { $response=Invoke-WebRequest -Uri 'http://localhost:4318/' -UseBasicParsing -TimeoutSec 2; if($response.StatusCode -eq 200){$ready=$true;break} } catch {}
  Start-Sleep -Seconds 2
}
if(!$ready){throw 'AI Center не ответил; браузер не запущен.'}
if($DebugPort -ne 0 -and ($DebugPort -lt 1024 -or $DebugPort -gt 65535)){throw 'Некорректный локальный debug port'}
$profile=Join-Path $DataDir 'Yandex-AICenter'
$arguments=@('--new-window','--start-maximized',('--user-data-dir="'+$profile+'"'),'http://localhost:4318/?page=intelligence')
if($DebugPort){$arguments+=('--remote-debugging-port='+$DebugPort);$arguments+='--remote-debugging-address=127.0.0.1'}
$oldHandles=@(Get-Process browser -ErrorAction SilentlyContinue | Where-Object {$_.MainWindowHandle -ne 0} | ForEach-Object {$_.MainWindowHandle})
Start-Process -FilePath $browser -ArgumentList $arguments -WindowStyle Maximized | Out-Null
if(-not ('RitmWindow' -as [type])){Add-Type 'using System;using System.Runtime.InteropServices;public static class RitmWindow {[DllImport("user32.dll")]public static extern bool ShowWindowAsync(IntPtr hWnd,int nCmdShow);[DllImport("user32.dll")]public static extern bool IsZoomed(IntPtr hWnd);}' }
$window=$null
for($attempt=0;$attempt -lt 30;$attempt++) {
  $window=Get-Process browser -ErrorAction SilentlyContinue | Where-Object {$_.MainWindowHandle -ne 0 -and ($oldHandles -notcontains $_.MainWindowHandle -or $_.MainWindowTitle -like '*RITM*')} | Select-Object -First 1
  if($window){[RitmWindow]::ShowWindowAsync($window.MainWindowHandle,3) | Out-Null;break}
  Start-Sleep -Milliseconds 500
}
('{0} opened_yandex maximized={1}' -f [DateTime]::UtcNow.ToString('o'),($window -and [RitmWindow]::IsZoomed($window.MainWindowHandle))) | Add-Content -LiteralPath (Join-Path $DataDir 'browser-launcher.log') -Encoding UTF8
Write-Output 'AI Center открыт в Яндекс Браузере.'