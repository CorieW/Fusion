param([Parameter(Mandatory=$true)][string]$RuntimeRoot)
$ErrorActionPreference = 'Stop'
# FNXC:LocalDeployment 2026-09-06-20:51: The sign-in task selects an immutable release and retains the operator's existing launch environment.
if (Test-Path -LiteralPath (Join-Path $RuntimeRoot 'maintenance.json')) { exit 0 }
$mutex = New-Object System.Threading.Mutex($false, 'Local\CustomFusionDashboard')
if (-not $mutex.WaitOne(0)) { exit 0 }
try {
    $active = Get-Content -LiteralPath (Join-Path $RuntimeRoot 'active.json') -Raw | ConvertFrom-Json
    $config = Get-Content -LiteralPath (Join-Path $RuntimeRoot 'config.json') -Raw | ConvertFrom-Json
    $cursorBin = (Join-Path $env:LOCALAPPDATA 'Programs\cursor\resources\app\bin').TrimEnd('\')
    $env:Path = (($env:Path -split ';' | Where-Object { $_.Trim().Trim('"').TrimEnd('\') -ine $cursorBin }) -join ';')
    $env:FUSION_LOCAL_CONTROL = $RuntimeRoot
    $env:FUSION_LOCAL_TOKEN = [guid]::NewGuid().ToString('N')
    $hook = (New-Object System.Uri((Join-Path $RuntimeRoot 'lifecycle.mjs'))).AbsoluteUri
    $env:NODE_OPTIONS = "$env:NODE_OPTIONS --import=$hook".Trim()
    $env:PATH = "$($config.pgTools);$env:PATH"
    Set-Location -LiteralPath $config.workingDirectory
    $logDir = Join-Path $RuntimeRoot 'logs\dashboard'
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    $logName = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '-' + $env:FUSION_LOCAL_TOKEN
    $nodeArguments = '"' + $active.cli + '" dashboard --no-auth --host 127.0.0.1 --port 4040'
    $dashboard = Start-Process -FilePath $config.node -ArgumentList $nodeArguments -WorkingDirectory $config.workingDirectory -WindowStyle Hidden -PassThru -Wait -RedirectStandardOutput (Join-Path $logDir "$logName.out.log") -RedirectStandardError (Join-Path $logDir "$logName.err.log")
    exit $dashboard.ExitCode
} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
