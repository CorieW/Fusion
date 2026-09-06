param([string]$Action, [string]$RuntimeRoot, [string]$OutputPath, [string]$TargetPath, [int]$ProcessId)
$ErrorActionPreference = 'Stop'
# FNXC:LocalDeployment 2026-09-06-20:51: Scope Task Scheduler and process operations to the existing Fusion task and verified process identities.
switch ($Action) {
    'WorkingDirectory' {
        # FNXC:LocalDeployment 2026-09-06-23:25: Keep personal project paths in local task/runtime configuration, outside Git history.
        $directory = (Get-ScheduledTask -TaskName 'RunFusion Dashboard').Actions | Select-Object -First 1 -ExpandProperty WorkingDirectory
        if ([string]::IsNullOrWhiteSpace($directory)) { throw 'The existing Fusion task needs a working directory before local configuration can be created' }
        [Environment]::ExpandEnvironmentVariables($directory)
    }
    'Inspect' {
        $task = Get-ScheduledTask -TaskName 'RunFusion Dashboard'
        $processes = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match '(RunFusion|Custom Fusion Runtime)' -and $_.CommandLine -match 'bin.mjs.*dashboard' } | Select-Object ProcessId,ParentProcessId,CommandLine)
        @{ state = [string]$task.State; enabled = $task.Settings.Enabled; processes = $processes } | ConvertTo-Json -Depth 4 -Compress
    }
    'Export' { Export-ScheduledTask -TaskName 'RunFusion Dashboard' | Set-Content -LiteralPath $OutputPath -Encoding Unicode }
    'Disable' { Disable-ScheduledTask -TaskName 'RunFusion Dashboard' | Out-Null }
    'Start' { Enable-ScheduledTask -TaskName 'RunFusion Dashboard' | Out-Null; Start-ScheduledTask -TaskName 'RunFusion Dashboard' }
    'Register' {
        $actionArgs = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $RuntimeRoot 'start.ps1') + '" -RuntimeRoot "' + $RuntimeRoot + '"'
        $config = Get-Content -LiteralPath (Join-Path $RuntimeRoot 'config.json') -Raw | ConvertFrom-Json
        $actionSpec = New-ScheduledTaskAction -Execute 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -Argument $actionArgs -WorkingDirectory $config.workingDirectory
        Set-ScheduledTask -TaskName 'RunFusion Dashboard' -Action $actionSpec | Out-Null
    }
    'RestoreTask' { Register-ScheduledTask -TaskName 'RunFusion Dashboard' -Xml (Get-Content -LiteralPath $TargetPath -Raw) -Force | Out-Null }
    'Protect' {
        $account = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        & icacls.exe $TargetPath /inheritance:r /grant:r "${account}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' 'BUILTIN\Administrators:(OI)(CI)F' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Failed to restrict backup permissions' }
    }
    'SuspendLegacy' {
        $p = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId"
        if ($p.Name -ne 'node.exe' -or $p.CommandLine -notmatch 'RunFusion.*bin.mjs.*dashboard') { throw 'Legacy supervisor identity mismatch' }
        Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class FusionSuspend { [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr h); }'
        $proc = Get-Process -Id $ProcessId
        if ([FusionSuspend]::NtSuspendProcess($proc.Handle) -ne 0) { throw 'Could not suspend legacy supervisor' }
    }
    'ResumeLegacy' {
        Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class FusionResume { [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr h); }'
        $proc = Get-Process -Id $ProcessId
        if ([FusionResume]::NtResumeProcess($proc.Handle) -ne 0) { throw 'Could not resume legacy supervisor' }
    }
    'StopLegacyParent' {
        $p = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId"
        if ($p.Name -ne 'node.exe' -or $p.CommandLine -notmatch 'RunFusion.*bin.mjs.*dashboard') { throw 'Legacy supervisor identity mismatch' }
        $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId")
        if ($children.Count -ne 0) { throw 'Legacy dashboard child has not finished graceful shutdown' }
        Stop-Process -Id $ProcessId -Force
        Stop-ScheduledTask -TaskName 'RunFusion Dashboard'
    }
    default { throw "Unknown Windows operation: $Action" }
}
