[CmdletBinding()]
param(
  [string]$KeyFile = '',
  [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'RITMIntelligence-Preview')
)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')).TrimEnd('\') + '\'
$dir = [IO.Path]::GetFullPath($DataDir).TrimEnd('\')
$configPath = Join-Path $dir 'config.json'
if ($dir.StartsWith($repo, [StringComparison]::OrdinalIgnoreCase)) { throw 'Каталог конфигурации должен быть вне Git.' }
$allowedSids = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18')
$dirAcl = Get-Acl -LiteralPath $dir
if (!$dirAcl.AreAccessRulesProtected) { throw 'Защищённый каталог должен иметь отключённое наследование ACL.' }
foreach ($rule in $dirAcl.Access) {
  if ($rule.AccessControlType -eq 'Allow' -and $allowedSids -notcontains $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value) { throw 'Каталог доступен посторонним; конфигурация не изменена.' }
}
$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$tailscaleReadOrigin = $false
if ($config.RITM_PUBLIC_ORIGIN) {
  # Preserve the existing remote read endpoint. A .ts.net name alone does not
  # prove private networking; all repair requests remain loopback-only.
  try {
    $origin = [Uri][string]$config.RITM_PUBLIC_ORIGIN
    $tailscaleReadOrigin = $origin.IsAbsoluteUri -and $origin.Scheme -eq 'https' -and $origin.IsDefaultPort -and !$origin.UserInfo -and !$origin.Query -and !$origin.Fragment -and $origin.AbsolutePath -eq '/' -and $origin.GetLeftPart([UriPartial]::Authority) -ceq [string]$config.RITM_PUBLIC_ORIGIN -and $origin.DnsSafeHost -cmatch '^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net$'
  } catch { $tailscaleReadOrigin = $false }
}
if (($config.RITM_AGENT_PORT -and [int]$config.RITM_AGENT_PORT -ne 4318) -or ($config.RITM_PUBLIC_ORIGIN -and !$tailscaleReadOrigin)) { throw 'Нужен основной агент localhost:4318. Удалённый адрес допускается только для существующего доступа через Tailscale; исправления доступны исключительно локально.' }
# Only existing RITM protected directories. Never print credential contents or request keys in chat.
if (!$KeyFile) {
  $keyCandidates = @()
  foreach ($folder in Get-ChildItem -LiteralPath $env:LOCALAPPDATA -Directory -Filter 'RITMIntelligence*') {
    foreach ($file in Get-ChildItem -LiteralPath $folder.FullName -File -Filter '*.json' -Recurse) {
      if ($file.Length -gt 20000) { continue }
      try {
        $candidate = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($candidate.type -eq 'service_account' -and $candidate.project_id -eq 'ritm-intelligence' -and $candidate.client_email -eq 'ritm-test-writer@ritm-intelligence.iam.gserviceaccount.com' -and $candidate.private_key) { $keyCandidates += $file.FullName }
      } catch {}
      $candidate = $null
    }
  }
  if ($keyCandidates.Count -eq 0) { throw 'Не найден отдельный защищённый ключ записи. Повторите команду с -KeyFile и локальным путём к ключу; не отправляйте ключ в чат.' }
  $KeyFile = $keyCandidates[0]
}
$source = (Resolve-Path -LiteralPath $KeyFile).Path
if ($source.StartsWith($repo, [StringComparison]::OrdinalIgnoreCase) -or (Get-Item -LiteralPath $source).Length -gt 20000) { throw 'Недопустимый файл ключа.' }
try { $key = Get-Content -LiteralPath $source -Raw -Encoding UTF8 | ConvertFrom-Json } catch { throw 'Не удалось прочитать файл ключа. Конфигурация не изменена.' }
if ($key.type -ne 'service_account' -or $key.project_id -ne 'ritm-intelligence' -or $key.client_email -eq 'ritm-table-doctor@ritm-intelligence.iam.gserviceaccount.com' -or $key.client_email -notmatch '^[a-z0-9-]+@ritm-intelligence\.iam\.gserviceaccount\.com$' -or !$key.private_key) { throw 'Нужен отдельный разрешённый аккаунт записи.' }
$writerEmail = [string]$key.client_email
$key = $null
$dest = Join-Path $dir 'production-writer-key.json'
if ($source -ne $dest) {
  if ((Test-Path -LiteralPath $dest) -and (Get-FileHash -LiteralPath $dest).Hash -ne (Get-FileHash -LiteralPath $source).Hash) { throw 'Защищённый ключ уже существует и отличается; он не заменён.' }
  if (!(Test-Path -LiteralPath $dest)) { Copy-Item -LiteralPath $source -Destination $dest }
}
# Start key DACL setup. Use the Windows DACL utility rather than Set-Acl:
# Set-Acl can request the audit privilege even after applying the right DACL.
# Already correct permissions need no mutation.
$existingAcl = Get-Acl -LiteralPath $dest
$needsAclChange = !$existingAcl.AreAccessRulesProtected
foreach ($rule in $existingAcl.Access) {
  if ($rule.AccessControlType -ne 'Allow' -or $allowedSids -notcontains $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -or $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl) { $needsAclChange = $true }
}
foreach ($sid in $allowedSids) {
  if (!@($existingAcl.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $sid }).Count) { $needsAclChange = $true }
}
if ($needsAclChange) {
  $icacls = (Get-Command icacls.exe -CommandType Application -ErrorAction Stop).Source
  $aclArgs = @($dest, '/grant:r')
  foreach ($sid in $allowedSids) { $aclArgs += ('*' + $sid + ':(F)') }
  $aclArgs += '/Q'
  $aclOutput = @(& $icacls @aclArgs 2>&1)
  if ($LASTEXITCODE -ne 0) { throw 'Windows не смогла защитить файл ключа. Конфигурация агента не изменена.' }
  $aclOutput = @(& $icacls $dest '/inheritance:r' '/Q' 2>&1)
  if ($LASTEXITCODE -ne 0) { throw 'Windows не смогла отключить наследование прав ключа. Конфигурация агента не изменена.' }
  $existingAcl = Get-Acl -LiteralPath $dest
  $unexpectedSids = @($existingAcl.Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } | Where-Object { $allowedSids -notcontains $_ } | Select-Object -Unique)
  if ($unexpectedSids.Count) {
    $aclArgs = @($dest, '/remove')
    foreach ($sid in $unexpectedSids) { $aclArgs += ('*' + $sid) }
    $aclArgs += '/Q'
    $aclOutput = @(& $icacls @aclArgs 2>&1)
    if ($LASTEXITCODE -ne 0) { throw 'Windows не смогла убрать лишний доступ к ключу. Конфигурация агента не изменена.' }
  }
  $deniedSids = @($existingAcl.Access | Where-Object { $_.AccessControlType -eq 'Deny' } | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } | Where-Object { $allowedSids -contains $_ } | Select-Object -Unique)
  if ($deniedSids.Count) {
    $aclArgs = @($dest, '/remove:d')
    foreach ($sid in $deniedSids) { $aclArgs += ('*' + $sid) }
    $aclArgs += '/Q'
    $aclOutput = @(& $icacls @aclArgs 2>&1)
    if ($LASTEXITCODE -ne 0) { throw 'Windows не смогла убрать запрет доступа к ключу. Конфигурация агента не изменена.' }
  }
}
$verifiedAcl = Get-Acl -LiteralPath $dest
if (!$verifiedAcl.AreAccessRulesProtected) { throw 'Не удалось отключить наследование прав файла ключа. Настройка остановлена.' }
foreach ($rule in $verifiedAcl.Access) {
  if ($rule.AccessControlType -ne 'Allow') { throw 'Обнаружен запрет доступа к ключу. Настройка остановлена.' }
  if ($rule.AccessControlType -eq 'Allow' -and $allowedSids -notcontains $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value) { throw 'Файл ключа доступен постороннему аккаунту. Настройка остановлена.' }
}
foreach ($sid in $allowedSids) {
  $fullControl = @($verifiedAcl.Access | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $sid -and ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl })
  if (!$fullControl.Count) { throw 'Права защищённого файла ключа не подтверждены. Настройка остановлена.' }
}
# End key DACL setup.
if ((Get-FileHash -LiteralPath $dest).Hash -ne (Get-FileHash -LiteralPath $source).Hash) { throw 'Копия ключа не прошла проверку.' }
$node = (Get-Command node -ErrorAction Stop).Source
Push-Location -LiteralPath $repo
try {
  $checkOutput = @(& $node (Join-Path $repo 'scripts\check-production-writer.mjs') $dest $writerEmail 2>&1)
  $checkExitCode = $LASTEXITCODE
  foreach ($line in $checkOutput) { Write-Output ([string]$line) }
} finally { Pop-Location }
if ($checkExitCode -ne 0) { throw 'Настройка остановлена до изменения config.json. Выполни точное действие из сообщения выше и запусти команду снова; скриншот или пересылать вывод не нужно.' }
Copy-Item -LiteralPath $configPath -Destination ($configPath + '.before-formula-repair') -Force
$config | Add-Member -NotePropertyName 'RITM_PRODUCTION_REPAIR_ENABLED' -NotePropertyValue 'true' -Force
$config | Add-Member -NotePropertyName 'RITM_PRODUCTION_WRITER_CREDENTIALS_FILE' -NotePropertyValue $dest -Force
$config | Add-Member -NotePropertyName 'RITM_PRODUCTION_WRITER_EMAIL' -NotePropertyValue $writerEmail -Force
$config.PSObject.Properties.Remove('RITM_TEST_WRITER_CREDENTIALS_FILE')
$config | Add-Member -NotePropertyName 'RITM_CHECK_INTERVAL_SECONDS' -NotePropertyValue '600' -Force
$config | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8
& (Join-Path $PSScriptRoot 'Restart-Agent.ps1') -DataDir $dir
Write-Output 'Подключение подготовлено. Утверждённые повреждённые ячейки можно исправлять только через отдельное подтверждение в AI Center. Производственных записей эта команда не выполняет.'
