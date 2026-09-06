# Your local Windows Fusion

Edit this checkout and deploy with PowerShell:

```powershell
cd 'A:\Custom Fusion'
.\scripts\fusion-local.ps1 Deploy
```

The command snapshots tracked files and non-ignored new source files, installs the repository's pinned pnpm dependencies, builds a complete release, and runs verification. Your running Fusion stays available during the build. Build output and dependencies live in `A:\Custom Fusion Runtime\releases`, independently of this checkout.

Machine-specific settings stay in the runtime directory's `config.json`. Initial configuration reads the working directory from the existing Windows task rather than storing a personal project path in source control. Keep that configuration, backups, manifests and operational reports outside this public repository.

Activation pauses new automatic dispatch and waits up to ten minutes for existing work to finish. If agents, task execution, or live AI sessions remain, it restores the previous dispatch settings and leaves activation pending. Finish the work and run `Activate`; it does not rebuild an already verified candidate.

```powershell
.\scripts\fusion-local.ps1 Build
.\scripts\fusion-local.ps1 Activate
.\scripts\fusion-local.ps1 Status
.\scripts\fusion-local.ps1 Backup
.\scripts\fusion-local.ps1 Verify -Release '<candidate-id>'
```

Activation pauses idle projects, disables the startup task temporarily, exports all PostgreSQL databases and roles, and stops Fusion cleanly before copying its global data and complete project/worktree directories. Backups include credentials: their Windows permissions are restricted to your account, Administrators and SYSTEM. Backups are stored under `A:\Fusion Backup Data`; no backup or release is automatically deleted.

The bundled Windows database helper force-stops PostgreSQL when Fusion exits. The command detects this, recovers the stopped cluster offline, and performs a clean PostgreSQL checkpoint and shutdown before taking the filesystem snapshot. No dashboard or project engine runs during that step.

Complete project trees are stored as uncompressed `.tar` archives, including Git metadata, ignored files, credentials, dependencies and uncommitted work. This makes integrity checks sequential instead of reopening hundreds of thousands of tiny files. Global Fusion data remains a directory snapshot. The initial migration backup uses directory snapshots for projects too; restoration supports both formats.

The candidate must pass a restore/migration rehearsal on copies, using an isolated Windows home and database. External connections and subprocess execution are blocked during the rehearsal. The live instance then opens the original data locations; project IDs and paths stay the same. Projects resume only after data checks pass.

The existing `RunFusion Dashboard` sign-in task resolves `active.json` in the runtime directory. It keeps its original sign-in delay, hidden execution, restart-on-failure settings, localhost URL, and authentication mode. Fusion's own supervisor handles runtime crashes; the Windows task retries launch failures. A probe on this machine confirmed that Task Scheduler alone does not retry a process that merely exits with a nonzero status. Agent timeout settings remain in use. No additional dashboard watchdog is installed. Automatic npm updates remain disabled.

## Rollback and interrupted operations

Use `Status` to see the selected release, task state, and maintenance journal. A lock or maintenance marker left by an interrupted operation deliberately prevents another deployment from overlapping it. Check the recorded process and phase before clearing a stale lock. Never remove a maintenance marker while a backup, migration or restore is running.

If activation was interrupted before migration, a completed, verified cold backup can resume it:

```powershell
.\scripts\fusion-local.ps1 Activate -Backup 'A:\Fusion Backup Data\Fusion-Full-<timestamp>'
```

This requires the original candidate, a disabled startup task, stopped Fusion and PostgreSQL, and an exact checksum match between the live global data and the backup. It reruns the migration rehearsal before starting production. Later failure phases require inspecting the journal and matching backup before recovery; they are deliberately refused by this shortcut.

For a release with an identical migration set:

```powershell
.\scripts\fusion-local.ps1 Rollback -Release '<previous-release-id>'
```

When schemas differ, explicitly choose the matching cold backup:

```powershell
.\scripts\fusion-local.ps1 Rollback -Release '<previous-release-id>' `
  -Backup 'A:\Fusion Backup Data\Fusion-Full-<timestamp>' -RestoreData
```

A data rollback first backs up the current state. Restored directories replace the live paths only after the displaced directories have been renamed and retained. Work done after the target backup remains in those preserved directories; it is not automatically merged into the older database.

The original npm installation and its exported task XML remain available for the initial upgrade rollback. Never point version 0.76.0 at a database already migrated by the fork: restore its matching database and filesystem snapshot together.

## Logs and source updates

`local-release.json` records the commit, uncommitted source hashes, dependency versions, checks and packaged-asset hashes. Build/check logs are under the runtime `logs` directory; migration rehearsals and acceptance reports are retained there too. Keep generated files, credentials, `.fusion` state and dependencies outside Git.

Changes in this checkout are intentionally local until committed. Use Git commits to preserve your edits before incorporating new work from the fork. Updating the checkout does not change the running release until you deploy it. Do not use the dashboard's source-rebuild button to modify an activated release; use the command above.
