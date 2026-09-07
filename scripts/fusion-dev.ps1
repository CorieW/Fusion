[CmdletBinding()]
param(
    [ValidateSet('Start', 'Stop', 'Status')][string]$Action = 'Start',
    [string]$RuntimeRoot = ''
)
$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path -Parent $PSScriptRoot
if (-not $RuntimeRoot) {
    $RuntimeRoot = Join-Path (Split-Path -Parent $sourceRoot) ((Split-Path -Leaf $sourceRoot) + ' Runtime')
}
$developmentRoot = Join-Path $RuntimeRoot 'development'
$markerPath = Join-Path $developmentRoot 'dev-isolation.json'
$identity = $null
if (Test-Path -LiteralPath $markerPath) {
    $identity = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
    if ($identity.kind -ne 'fusion-development' -or $identity.source -ne $sourceRoot) { throw 'Development directory belongs to another checkout.' }
}
$running = $false
if ($identity) {
    try {
        $actual = Invoke-RestMethod 'http://127.0.0.1:4050/__fusion_dev_identity' -TimeoutSec 2
        $running = $actual.kind -eq 'fusion-development' -and $actual.token -eq $identity.token
    } catch { $running = $false }
}
if ($Action -eq 'Status') {
    [pscustomobject]@{ Running = $running; Url = 'http://127.0.0.1:5184'; Storage = $developmentRoot }
    return
}
if ($Action -eq 'Stop') {
    if (-not $identity) { throw 'No owned development instance exists.' }
    Set-Content -LiteralPath (Join-Path $developmentRoot 'stop-request') -Value 'stop'
    Write-Output 'Requested graceful development shutdown.'
    return
}
if ($running) { Write-Output 'Development preview is already running: http://127.0.0.1:5184'; return }
New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
$previous = @{}
foreach ($key in @('FUSION_DEV_ISOLATED_DIR', 'FUSION_API_PORT', 'FUSION_VITE_PORT')) { $previous[$key] = [Environment]::GetEnvironmentVariable($key, 'Process') }
try {
    $env:FUSION_DEV_ISOLATED_DIR = $developmentRoot
    $env:FUSION_API_PORT = '4050'
    $env:FUSION_VITE_PORT = '5184'
    Start-Process -FilePath (Get-Command node -ErrorAction Stop).Source -ArgumentList ('"' + (Join-Path $PSScriptRoot 'dev-hmr.mjs') + '"') -WorkingDirectory $sourceRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $RuntimeRoot 'development.out.log') -RedirectStandardError (Join-Path $RuntimeRoot 'development.err.log') | Out-Null
} finally {
    foreach ($key in $previous.Keys) { [Environment]::SetEnvironmentVariable($key, $previous[$key], 'Process') }
}
Write-Output 'Starting isolated development at http://127.0.0.1:5184. Startup logs are in the runtime directory.'
