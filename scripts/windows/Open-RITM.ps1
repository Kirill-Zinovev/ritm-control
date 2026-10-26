[CmdletBinding()]
param(
  [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'RITMIntelligence-Preview'),
  [string]$TaskName = 'RITM Intelligence',
  [ValidateSet('overview','assembly','printing','production','stock','supplies','intelligence','sources')]
  [string]$Page = 'printing'
)
$ErrorActionPreference = 'Stop'
$resolvedDataDir = [IO.Path]::GetFullPath($DataDir)
$secretPath = Join-Path $resolvedDataDir 'owner.secrets.xml'
$ownerSecret = $null
$headers = $null
try {
  if (!(Test-Path -LiteralPath $secretPath -PathType Leaf)) { throw 'RITM owner session is not initialized.' }
  $ownerSecret = Import-Clixml -LiteralPath $secretPath
  $token = [PSCredential]::new('owner', $ownerSecret.OwnerToken).GetNetworkCredential().Password
  $headers = @{ Authorization = 'Bearer ' + $token }
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  $listeners = @(Get-NetTCPConnection -LocalPort 4318 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
  if ($listeners.Count -gt 1) { throw 'Multiple RITM agents are listening. No new process was started.' }
  $startRequested = $false
  if ($listeners.Count -eq 0 -and $task.State -ne 'Running') {
    Start-ScheduledTask -TaskName $TaskName
    $startRequested = $true
  }

  $ready = $false
  for ($attempt = 0; $attempt -lt 90; $attempt++) {
    try {
      $status = Invoke-RestMethod -Uri 'http://localhost:4318/api/intelligence/status' -Headers $headers -TimeoutSec 3
      $listeners = @(Get-NetTCPConnection -LocalPort 4318 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
      if ($listeners.Count -gt 1) { throw 'Multiple RITM agents are listening. No browser was opened.' }
      if ($listeners.Count -eq 1 -and $status.agent.status -eq 'running' -and [int]$status.agent.pid -eq [int]$listeners[0]) {
        $ready = $true
        break
      }
    } catch {
      if ($_.Exception.Message -like 'Multiple RITM agents*') { throw }
    }
    $task = Get-ScheduledTask -TaskName $TaskName
    if ($task.State -ne 'Running') {
      $listeners = @(Get-NetTCPConnection -LocalPort 4318 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
      if ($listeners.Count -eq 0 -and !$startRequested) {
        Start-ScheduledTask -TaskName $TaskName
        $startRequested = $true
      }
    }
    Start-Sleep -Seconds 2
  }
  if (!$ready) { throw 'RITM did not become healthy in time. Check the Windows task and local agent logs.' }
  $openResult = & (Join-Path $PSScriptRoot 'Open-AICenter.ps1') -DataDir $resolvedDataDir -Page $Page
  if (!$?) { throw 'Yandex Browser could not be opened.' }
  Write-Output $openResult
} catch {
  try {
    $dialog = New-Object -ComObject WScript.Shell
    [void]$dialog.Popup($_.Exception.Message, 0, 'RITM', 0x10)
  } catch {}
  exit 1
} finally {
  if ($headers) { $headers.Clear() }
  Remove-Variable token -ErrorAction SilentlyContinue
  Remove-Variable ownerSecret -ErrorAction SilentlyContinue
}
