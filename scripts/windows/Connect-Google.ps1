[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$KeyFile,
  [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'RITMIntelligence')
)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')).TrimEnd('\') + '\'
$dir = [IO.Path]::GetFullPath($DataDir).TrimEnd('\')
$source = (Resolve-Path -LiteralPath $KeyFile).Path
if ($dir.StartsWith($repo,[StringComparison]::OrdinalIgnoreCase) -or $source.StartsWith($repo,[StringComparison]::OrdinalIgnoreCase)) { throw 'Ключ и каталог данных должны находиться вне репозитория.' }
$configFile = Join-Path $dir 'config.json'
if (!(Test-Path -LiteralPath $configFile)) { throw 'Сначала настройте владельца через Initialize-Agent.ps1.' }
$acl = Get-Acl -LiteralPath $dir
$allowedSids = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18')
if (!$acl.AreAccessRulesProtected) { throw 'Каталог должен иметь отключённое наследование ACL.' }
foreach ($rule in $acl.Access) {
  $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
  if ($rule.AccessControlType -eq 'Allow' -and $allowedSids -notcontains $sid) { throw 'Каталог доступен посторонним. Используйте защищённый каталог Initialize-Agent.' }
}
if ((Get-Item -LiteralPath $source).Length -gt 20000) { throw 'Неверный размер файла ключа.' }
try { $key = Get-Content -LiteralPath $source -Raw -Encoding UTF8 | ConvertFrom-Json } catch { throw 'Не удалось прочитать JSON ключа.' }
if ($key.type -ne 'service_account' -or $key.project_id -ne 'ritm-intelligence' -or $key.client_email -ne 'ritm-table-doctor@ritm-intelligence.iam.gserviceaccount.com' -or !$key.private_key -or $key.token_uri -ne 'https://oauth2.googleapis.com/token') { throw 'Файл не является ключом разрешённого сервисного аккаунта.' }
$key = $null
$dest = Join-Path $dir 'google-key.json'
if ($source -ne $dest) {
  if (Test-Path -LiteralPath $dest) { throw 'Ключ уже существует. Для ротации укажите существующий защищённый файл явно.' }
  Copy-Item -LiteralPath $source -Destination $dest
}
$fileAcl = Get-Acl -LiteralPath $dest
$fileAcl.SetAccessRuleProtection($true,$false)
foreach ($existingRule in @($fileAcl.Access)) { [void]$fileAcl.RemoveAccessRuleSpecific($existingRule) }
foreach ($sid in $allowedSids) { $fileAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','Allow')) }
Set-Acl -LiteralPath $dest -AclObject $fileAcl
$config = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
$config | Add-Member -NotePropertyName 'RITM_GOOGLE_CREDENTIALS_FILE' -NotePropertyValue $dest -Force
$config | Add-Member -NotePropertyName 'RITM_DOCTOR_DEMO_ENABLED' -NotePropertyValue 'false' -Force
$config | ConvertTo-Json | Set-Content -LiteralPath $configFile -Encoding UTF8
Write-Output 'Метаданные ключа проверены; путь подключён. Перезапустите агент. Успех чтения API ещё не подтверждён.'
Write-Output 'Скачанная исходная копия не удалена; удалите её после проверки защищённого подключения.'