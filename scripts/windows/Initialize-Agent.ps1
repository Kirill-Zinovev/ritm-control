[CmdletBinding()]
param(
  [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'RITMIntelligence'),
  [string]$RitmUrl = 'https://ritm-erp.zinovevkirill234.chatgpt.site',
  [ValidateRange(60,86400)][int]$IntervalSeconds = 600,
  [switch]$EnableTelegram,
  [switch]$ConfigureTelegram
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Эта настройка предназначена для Windows.' }
$resolvedDataDir = [IO.Path]::GetFullPath($DataDir)
$secretPath = Join-Path $resolvedDataDir 'owner.secrets.xml'
if ($ConfigureTelegram) {
  $configPath = Join-Path $resolvedDataDir 'config.json'
  if (!(Test-Path -LiteralPath $secretPath) -or !(Test-Path -LiteralPath $configPath)) { throw 'Существующая конфигурация агента не найдена.' }
  $secrets = Import-Clixml -LiteralPath $secretPath
  $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $botToken = Read-Host 'Токен Telegram-бота (скрытый ввод, не отправляйте в чат)' -AsSecureString
  $chatId = Read-Host 'Числовой chat_id владельца; сначала отправьте боту /start'
  if ($botToken.Length -lt 10 -or $chatId -notmatch '^-?\d+$') { throw 'Нужны токен бота и числовой chat_id; настройки не изменены.' }
  $secrets.TelegramToken = $botToken
  $secrets.TelegramChatId = $chatId
  $secrets | Export-Clixml -LiteralPath ($secretPath + '.tmp')
  Move-Item -LiteralPath ($secretPath + '.tmp') -Destination $secretPath -Force
  $config | Add-Member -NotePropertyName 'RITM_TELEGRAM_ENABLED' -NotePropertyValue 'true' -Force
  $config | ConvertTo-Json | Set-Content -LiteralPath ($configPath + '.tmp') -Encoding UTF8
  Move-Item -LiteralPath ($configPath + '.tmp') -Destination $configPath -Force
  Write-Output 'Telegram сохранён в DPAPI. Ключ владельца и Google не изменены. Перезапустите существующее задание агента.'
  return
}
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
