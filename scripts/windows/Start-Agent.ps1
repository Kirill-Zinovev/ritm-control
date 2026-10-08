[CmdletBinding()]
param([string]$DataDir = (Join-Path $env:LOCALAPPDATA 'RITMIntelligence'))
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$resolvedDataDir = [IO.Path]::GetFullPath($DataDir)
$configPath = Join-Path $resolvedDataDir 'config.json'
$secretPath = Join-Path $resolvedDataDir 'owner.secrets.xml'
if (!(Test-Path -LiteralPath $configPath) -or !(Test-Path -LiteralPath $secretPath)) { throw 'Сначала выполните Initialize-Agent.ps1.' }
$nodeExe = (Get-Command node -ErrorAction Stop).Source
$version = & $nodeExe --version
if ([version]$version.TrimStart('v') -lt [version]'24.12.0') { throw 'Для локального агента нужен Node.js 24.12 или новее.' }
$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$allowed = @('RITM_DATA_DIR','RITM_BASE_URL','RITM_CHECK_INTERVAL_SECONDS','RITM_AGENT_PORT','RITM_REQUEST_TIMEOUT_SECONDS','RITM_REQUEST_RETRIES','RITM_SLOW_API_MS','RITM_SNAPSHOT_MAX_AGE_SECONDS','RITM_SOURCE_REGISTRY','RITM_DEV_ORIGIN','RITM_TELEGRAM_ENABLED','RITM_AI_MODEL','RITM_GOOGLE_CREDENTIALS_FILE','RITM_DOCTOR_REGISTRY','RITM_DOCTOR_DEMO_ENABLED')
foreach ($property in $config.PSObject.Properties) {
  if ($allowed -notcontains $property.Name) { throw ('Неизвестный параметр конфигурации: ' + $property.Name) }
  [Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value, 'Process')
}
$secrets = Import-Clixml -LiteralPath $secretPath
try {
  $env:RITM_OWNER_TOKEN = [PSCredential]::new('owner', $secrets.OwnerToken).GetNetworkCredential().Password
  if ($secrets.TelegramToken) { $env:RITM_TELEGRAM_BOT_TOKEN = [PSCredential]::new('bot', $secrets.TelegramToken).GetNetworkCredential().Password }
  $env:RITM_TELEGRAM_OWNER_CHAT_ID = $secrets.TelegramChatId
  Set-Location -LiteralPath $repoRoot
  & $nodeExe 'agent/index.js'
  $agentExitCode = $LASTEXITCODE
} finally {
  Remove-Item Env:RITM_OWNER_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:RITM_TELEGRAM_BOT_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:RITM_TELEGRAM_OWNER_CHAT_ID -ErrorAction SilentlyContinue
}
exit $agentExitCode
