[CmdletBinding()]
param([string]$DataDir = (Join-Path $env:LOCALAPPDATA 'RITMIntelligence-Preview'))
$ErrorActionPreference = 'Stop'
$syncDataDir = [IO.Path]::GetFullPath($DataDir)
$syncRepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if ($syncDataDir.StartsWith($syncRepoRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or $syncDataDir -eq $syncRepoRoot) { throw 'Sync secrets must be outside the repository.' }
$configPath = Join-Path $syncDataDir 'config.json'
if (!(Test-Path -LiteralPath $configPath)) { throw 'Initialize the existing RITM agent first.' }
$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$secretPath = Join-Path $syncDataDir 'assembly-sync.secret'
if ($config.RITM_ASSEMBLY_SYNC_SECRET_FILE -and [IO.Path]::GetFullPath($config.RITM_ASSEMBLY_SYNC_SECRET_FILE) -ne $secretPath) { throw 'An existing sync key uses a different path; review it before changing configuration.' }
if (Test-Path -LiteralPath $secretPath) {
  $syncKey = [IO.File]::ReadAllText($secretPath).Trim()
  if ($syncKey -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid existing sync key; no changes made.' }
} else {
  $bytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  $syncKey = [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
  [IO.File]::WriteAllText($secretPath, $syncKey, (New-Object Text.UTF8Encoding($false)))
}
$acl = New-Object Security.AccessControl.FileSecurity
$acl.SetAccessRuleProtection($true, $false)
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'Allow'))
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-18'), 'FullControl', 'Allow'))
Set-Acl -LiteralPath $secretPath -AclObject $acl
$backupPath = Join-Path $syncDataDir ('config.before-assembly-sync-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fff') + '.json')
Copy-Item -LiteralPath $configPath -Destination $backupPath
$config | Add-Member -NotePropertyName RITM_ASSEMBLY_SYNC_SECRET_FILE -NotePropertyValue $secretPath -Force
[IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding($false)))
Remove-Variable syncKey,bytes -ErrorAction SilentlyContinue
Write-Output ('Assembly sync key prepared in protected file: ' + $secretPath)
Write-Output 'No restart, Apps Script publication or trigger change was performed.'
