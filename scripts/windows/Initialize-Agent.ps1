[CmdletBinding()]
param(
  [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'RITMIntelligence'),
  [string]$RitmUrl = 'https://ritm-erp.zinovevkirill234.chatgpt.site',
  [ValidateRange(60,86400)][int]$IntervalSeconds = 600,
  [switch]$EnableTelegram
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Эта настройка предназначена для Windows.' }
$resolvedDataDir = [IO.Path]::GetFullPath($DataDir)
$secretPath = Join-Path $resolvedDataDir 'owner.secrets.xml'
if (Test-Path -LiteralPath $secretPath) { throw 'Настройка владельца уже существует; прежняя конфигурация не перезаписывается.' }
New-Item -ItemType Directory -Force -Path $resolvedDataDir | Out-Null
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$acl = Get-Acl -LiteralPath $resolvedDataDir
$acl.SetAccessRuleProtection($true, $false)
$inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
$propagation = [Security.AccessControl.PropagationFlags]::None
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity.User, 'FullControl', $inheritance, $propagation, 'Allow'))
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-18'), 'FullControl', $inheritance, $propagation, 'Allow'))
Set-Acl -LiteralPath $resolvedDataDir -AclObject $acl
$ownerToken = Read-Host 'Введите ключ владельца (минимум 32 символа; сохраните в менеджере паролей)' -AsSecureString
if ($ownerToken.Length -lt 32) { throw 'Ключ должен содержать минимум 32 символа.' }
$secrets = [PSCustomObject]@{ OwnerToken = $ownerToken; TelegramToken = $null; TelegramChatId = '' }
if ($EnableTelegram) {
  $secrets.TelegramToken = Read-Host 'Токен Telegram-бота' -AsSecureString
  $secrets.TelegramChatId = Read-Host 'Числовой chat_id владельца'
  if ($secrets.TelegramToken.Length -lt 10 -or $secrets.TelegramChatId -notmatch '^-?\d+$') { throw 'Нужны токен бота и числовой chat_id владельца.' }
}
$secrets | Export-Clixml -LiteralPath $secretPath
$config = @{ RITM_DATA_DIR = $resolvedDataDir; RITM_BASE_URL = $RitmUrl; RITM_CHECK_INTERVAL_SECONDS = [string]$IntervalSeconds; RITM_TELEGRAM_ENABLED = if ($EnableTelegram) { 'true' } else { 'false' } }
$config | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $resolvedDataDir 'config.json') -Encoding UTF8
Write-Output 'Настройки сохранены. Секреты зашифрованы Windows DPAPI для текущего пользователя.'
Write-Output 'Запуск: .\scripts\windows\Start-Agent.ps1'
Write-Output 'Кабинет: http://127.0.0.1:4318/?page=intelligence'
