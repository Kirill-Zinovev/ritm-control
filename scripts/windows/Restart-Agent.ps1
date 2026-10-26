[CmdletBinding()]
param([string]$DataDir = (Join-Path $env:LOCALAPPDATA 'RITMIntelligence-Preview'), [string]$TaskName = 'RITM Intelligence')
$ErrorActionPreference = 'Stop'
$resolvedDataDir = [IO.Path]::GetFullPath($DataDir)
$ownerSecret = Import-Clixml -LiteralPath (Join-Path $resolvedDataDir 'owner.secrets.xml')
$ownerHeaders = @{ Authorization = 'Bearer ' + [PSCredential]::new('owner', $ownerSecret.OwnerToken).GetNetworkCredential().Password }
$nodeExe = (Get-Command node -ErrorAction Stop).Source
$databaseFile = Join-Path $resolvedDataDir 'intelligence.sqlite'
function ConvertTo-UtcDateTime($value) {
  if ($value -is [DateTime]) { return $value.ToUniversalTime() }
  return [DateTimeOffset]::Parse([string]$value).UtcDateTime
}
try {
  # Exact authenticated main API and its Windows listener identify the process. Test port 4319 is never targeted.
  $state = Invoke-RestMethod -Uri 'http://localhost:4318/api/intelligence/status' -Headers $ownerHeaders -TimeoutSec 10
  $agentPid = [int]$state.agent.pid
  $listener = Get-NetTCPConnection -LocalPort 4318 -State Listen
  if (!$agentPid -or $listener.OwningProcess -notcontains $agentPid) { throw 'Cannot verify main process' }
  $agentProcess = Get-Process -Id $agentPid
  $agentStartedAt = $agentProcess.StartTime
  if ($agentProcess.ProcessName -ne 'node' -or $agentProcess.Path -ne $nodeExe) { throw 'Unexpected main executable' }
  $task = Get-ScheduledTask -TaskName $TaskName
  if (!$task) { throw 'Existing scheduled task is missing' }
  # Legacy scans can approach ten minutes; wait up to twelve before refusing restart.
  for ($attempt = 0; $attempt -lt 360; $attempt++) {
    $doctorState = Invoke-RestMethod -Uri 'http://localhost:4318/api/intelligence/doctor' -Headers $ownerHeaders -TimeoutSec 10
    if (!$doctorState.running -and !$doctorState.fastRunning) { break }
    Start-Sleep -Seconds 2
  }
  if ($doctorState.running -or $doctorState.fastRunning) { throw 'Doctor or fast check is still running; no interruption performed' }
  $backupDir = Join-Path $resolvedDataDir 'backups'
  New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
  $backupFile = Join-Path $backupDir ('before-formula-intelligence-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '.sqlite')
  $maintenanceFile = Join-Path $PSScriptRoot 'agent-maintenance.mjs'
  & $nodeExe $maintenanceFile backup $databaseFile $backupFile $agentPid
  if ($LASTEXITCODE -ne 0) { throw 'Backup failed; agent was not stopped' }
  Stop-ScheduledTask -TaskName $TaskName
  try {
  $remaining = Get-Process -Id $agentPid -ErrorAction SilentlyContinue
  if ($remaining) {
    if ($remaining.StartTime -ne $agentStartedAt -or $remaining.Path -ne $nodeExe) { throw 'PID changed; process not stopped' }
    Stop-Process -Id $agentPid -Force
    Wait-Process -Id $agentPid -Timeout 10 -ErrorAction SilentlyContinue
  }
  # Remove only the stopped, authenticated main agent's lease, preserving every incident and snapshot.
  # If recovery already launched a new instance, its metadata prevents clearing its lease.
  & $nodeExe $maintenanceFile release $databaseFile $backupFile $agentPid
  if ($LASTEXITCODE -ne 0) { throw 'Lease changed; inspect the existing task' }
  } finally {
    # Even a maintenance failure must resume the existing background task.
  $restartStarted = [DateTime]::UtcNow
  Start-ScheduledTask -TaskName $TaskName
  }
  $verified = $false
  $verificationFailure = $null
  # The new process serializes a full deep pass and a fast pass after startup.
  # Allow the verified sequence to finish even when the Google API is paced.
  for ($attempt = 0; $attempt -lt 360; $attempt++) {
    try {
      $doctorState = Invoke-RestMethod -Uri 'http://localhost:4318/api/intelligence/doctor' -Headers $ownerHeaders -TimeoutSec 5
      $metrics = @($doctorState.formulaIntelligence.metrics)
      $freshMetrics = @($metrics | Where-Object { $_.at -and (ConvertTo-UtcDateTime $_.at) -ge $restartStarted })
      $googleDocuments = @($doctorState.documents | Where-Object { !$_.demonstration })
      $deepRequests = 0
      $deepRetries = 0
      $deepDurationMs = 0
      $badDeepStatus = $false
      foreach ($document in $googleDocuments) {
        if (!$document.check -or $document.check.status -ne 'ok' -or !$document.check.api) { $badDeepStatus = $true; continue }
        $deepRequests += [int]$document.check.api.readRequests
        $deepRetries += [int]$document.check.api.retries
        $deepDurationMs += [int]$document.check.durationMs
        foreach ($status in $document.check.api.statuses.PSObject.Properties) {
          if ([int]$status.Value -gt 0 -and $status.Name -notmatch '^2\d{2}$') { $badDeepStatus = $true }
        }
      }
      $deepFinished = !$doctorState.running -and $doctorState.lastCheck -and (ConvertTo-UtcDateTime $doctorState.lastCheck) -ge $restartStarted
      $deepVerified = $deepFinished -and $doctorState.connection -eq 'verified' -and $googleDocuments.Count -eq 4 -and $metrics.Count -eq 10 -and $freshMetrics.Count -eq 10 -and !@($metrics | Where-Object { $_.stale -or !$_.fullSheetRead }).Count -and !$badDeepStatus -and $deepRetries -eq 0
      $fast = $doctorState.formulaIntelligence.fastCheck
      $fastFinished = $fast -and !$doctorState.fastRunning -and $fast.at -and (ConvertTo-UtcDateTime $fast.at) -ge $restartStarted
      $fastSheets = @($fast.documents | ForEach-Object { $_.sheets } | Where-Object { $_ })
      $badFastSheets = @($fastSheets | Where-Object { $_.status -ne 'ok' -or $_.errorCode })
      $fastVerified = $fastFinished -and $fast.status -eq 'ok' -and $fast.readRequests -gt 0 -and $fast.checkedCells -gt 0 -and $fast.retries -eq 0 -and $fastSheets.Count -eq 10 -and !$badFastSheets.Count
      if ($deepFinished -and !$deepVerified) { $verificationFailure = 'Fresh ten-sheet scan reported incomplete data or a Google API error; no further setup changes were made'; break }
      if ($fastFinished -and !$fastVerified) { $verificationFailure = 'Fresh fast scan reported incomplete data or a Google API retry/error; no further setup changes were made'; break }
      if ($deepVerified -and $fastVerified) { $verified = $true; break }
    } catch {}
    Start-Sleep -Seconds 2
  }
  if ($verificationFailure) { throw $verificationFailure }
  if (!$verified) { throw 'New agent did not finish verified ten-sheet scan; check private launcher log' }
  Write-Output ('Быстрая проверка: {0} мс; Google GET: {1}; ячеек: {2}; повторов API: {3}' -f $fast.durationMs,$fast.readRequests,$fast.checkedCells,$fast.retries)
  Write-Output ('Глубокая проверка: {0} мс по четырём документам; Google GET: {1}; повторов API: {2}; листов: 10' -f $deepDurationMs,$deepRequests,$deepRetries)
  $doctorState.formulaIntelligence.metrics | Select-Object document,sheet,formulasRead,protectedCells,checkedCells,unprotectedFormulas,durationMs,readRequests
  $updatedStatus = Invoke-RestMethod -Uri 'http://localhost:4318/api/intelligence/status' -Headers $ownerHeaders -TimeoutSec 10
  & $nodeExe $maintenanceFile verify $databaseFile $backupFile ([int]$updatedStatus.agent.pid)
  if ($LASTEXITCODE -ne 0) { throw 'SQLite history or approved formula baseline verification failed; AI Center was not opened' }
  & (Join-Path $PSScriptRoot 'Open-AICenter.ps1') -DataDir $resolvedDataDir
  Write-Output 'Агент обновлён. Эталоны требуют утверждения; изменение Google-ячейки возможно только после отдельного подтверждения владельца.'
} finally {
  $ownerHeaders.Clear()
  Remove-Variable ownerSecret -ErrorAction SilentlyContinue
}
