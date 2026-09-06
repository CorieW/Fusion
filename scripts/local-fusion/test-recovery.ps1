param([switch]$Fixture, [string]$StateDir, [string]$RuntimeRoot = 'A:\Custom Fusion Runtime')
$ErrorActionPreference = 'Stop'
# FNXC:LocalDeployment 2026-09-06-21:06: Verify the existing Task Scheduler failure policy with a disposable task, never by crashing the live dashboard.
if ($Fixture) {
    if (-not (Test-Path -LiteralPath (Join-Path $StateDir 'first-attempt'))) {
        [IO.File]::WriteAllText((Join-Path $StateDir 'first-attempt'), [DateTime]::UtcNow.ToString('o'))
        exit 41
    }
    [IO.File]::WriteAllText((Join-Path $StateDir 'recovered'), [DateTime]::UtcNow.ToString('o'))
    exit 0
}
$taskName = 'Custom Fusion Recovery Test ' + [guid]::NewGuid().ToString('N')
$StateDir = Join-Path $RuntimeRoot ('recovery-test-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'))
New-Item -ItemType Directory -Path $StateDir | Out-Null
$original = Get-ScheduledTask -TaskName 'RunFusion Dashboard'
$args = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $PSCommandPath + '" -Fixture -StateDir "' + $StateDir + '"'
$launchDirectory = Join-Path $StateDir 'launch-working-directory'
$action = New-ScheduledTaskAction -Execute 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -Argument $args -WorkingDirectory $launchDirectory
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(10)
$task = New-ScheduledTask -Action $action -Settings $original.Settings -Principal $original.Principal -Trigger $trigger
try {
    Register-ScheduledTask -TaskName $taskName -InputObject $task | Out-Null
    Export-ScheduledTask -TaskName $taskName | Set-Content -LiteralPath (Join-Path $StateDir 'task.xml') -Encoding Unicode
    $deadline = [DateTime]::UtcNow.AddSeconds(100)
    $launchFailure = $null
    while (-not (Test-Path -LiteralPath (Join-Path $StateDir 'recovered'))) {
        if ([DateTime]::UtcNow -gt $deadline) {
            Get-ScheduledTaskInfo -TaskName $taskName | Select-Object LastRunTime,LastTaskResult,NextRunTime | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $StateDir 'failure.json')
            throw 'Failure recovery test timed out'
        }
        $info = Get-ScheduledTaskInfo -TaskName $taskName
        if (-not $launchFailure -and $info.LastTaskResult -in @(2147942402,2147942667,2147942403)) {
            $launchFailure = $info.LastTaskResult
            [IO.File]::WriteAllText((Join-Path $StateDir 'first-attempt'), [DateTime]::UtcNow.ToString('o'))
            New-Item -ItemType Directory -Path $launchDirectory | Out-Null
        }
        Start-Sleep -Seconds 1
    }
    @{ passed = $true; launchFailure = $launchFailure; firstAttempt = Get-Content -LiteralPath (Join-Path $StateDir 'first-attempt'); recovered = Get-Content -LiteralPath (Join-Path $StateDir 'recovered'); restartInterval = $original.Settings.RestartInterval; restartCount = $original.Settings.RestartCount } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $StateDir 'result.json') -Encoding UTF8
    Write-Output "Startup failure recovery passed: $StateDir"
} finally {
    $testTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($testTask) { Stop-ScheduledTask -TaskName $taskName; Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
}
