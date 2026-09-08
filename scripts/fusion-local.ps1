param(
    [ValidateSet('Build','Verify','Activate','Deploy','Status','Backup','Rollback')]
    [string]$Action = 'Status',
    [string]$Release,
    [string]$Backup,
    [switch]$RestoreData,
    [switch]$Offline,
    [string]$RuntimeRoot = 'A:\Custom Fusion Runtime',
    [string]$BackupRoot = 'A:\Fusion Backup Data'
)
$ErrorActionPreference = 'Stop'
# FNXC:LocalDeployment 2026-09-06-20:51: Keep local builds, verified backups and activation behind one Windows command.
$arguments = @((Join-Path $PSScriptRoot 'local-fusion\manage.mjs'), $Action, '--runtime', $RuntimeRoot, '--backups', $BackupRoot)
if ($Release) { $arguments += @('--release', $Release) }
if ($Backup) { $arguments += @('--backup', $Backup) }
if ($RestoreData) { $arguments += '--restore-data' }
if ($Offline) { $arguments += '--offline' }
$previousPoolSize=$env:UV_THREADPOOL_SIZE
try {
    $env:UV_THREADPOOL_SIZE='32'
    & (Get-Command node.exe -ErrorAction Stop).Source @arguments
    $result=$LASTEXITCODE
} finally { $env:UV_THREADPOOL_SIZE=$previousPoolSize }
exit $result
