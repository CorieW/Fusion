import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { api, contained, copyTree, here, ps, readJson, restoreSnapshot, run, timestamp, waitUntil, writeJson } from './common.mjs';
import { assertWorkflowReferences, compareInventory, inventory, literal, sql, verifyBackup } from './backup.mjs';

// FNXC:LocalDeployment 2026-09-06-20:56: Rehearse the exact candidate against a restored database, separate Windows home and remapped projects before touching live data.
// process-supervisor-allowlist: isolated standalone deployment rehearsal; attached dashboard receives a graceful stop marker in finally.
export async function rehearse(config, release, backup, verifiedManifest) {
  const manifest = verifiedManifest ?? await verifyBackup(backup);
  const baseline = await readJson(path.join(backup, 'inventory.json'));
  const root = path.join(config.runtime, 'rehearsals', timestamp());
  await fs.mkdir(root, { recursive: true });
  await ps('Protect', ['-TargetPath', root]);
  const profile = path.join(root, 'profile');
  const control = path.join(root, 'control');
  await fs.mkdir(control, { recursive: true });
  await copyTree(path.join(backup,'global'), path.join(profile,'.fusion'), ['embedded-postgres']);
  const settingsFile = path.join(profile,'.fusion/settings.json');
  const settings = await readJson(settingsFile);
  Object.assign(settings, { autoUpdateAndRestart: false, autoBackupEnabled: false, updateCheckEnabled: false, localNetworkDiscoveryEnabled: false, ntfyEnabled: false, webhookEnabled: false, settingsSyncEnabled: false, mcpServers: [], remoteAccess: { enabled: false }, testMode: true, enginePaused: true });
  await writeJson(settingsFile, settings);
  for (const copy of manifest.copies.filter(c => c.kind !== 'global')) {
    const target=path.join(root,copy.destination);
    await fs.mkdir(target,{recursive:true});
    // FNXC:LocalDeployment 2026-09-06-21:06: The UI-only rehearsal needs project state, not hundreds of thousands of dependency files. The complete working trees remain in the verified backup.
    try {await restoreSnapshot(copy,backup,target,true);}catch(e){if(copy.kind==='project')throw e;}
    await fs.mkdir(path.join(target,'.git'),{recursive:true});
  }
  const pgData = path.join(root,'postgres');
  const pwFile = path.join(root,'pg-password');
  await fs.writeFile(pwFile,'password\n');
  await run(path.join(config.pgNative,'initdb.exe'), ['-D',pgData,'-U','postgres','--pwfile',pwFile,'--auth=scram-sha-256','--encoding=UTF8','--locale=C']);
  const pgPort = config.rehearsalPgPort ?? 55441;
  const uiPort = config.rehearsalUiPort ?? 4048;
  const conn = { port: pgPort, database: 'fusion' };
  const pgEnv = { ...process.env, PGPASSWORD: 'password' };
  let started = false, child;
  const out = await fs.open(path.join(root,'dashboard.log'),'a');
  try {
    await run(path.join(config.pgNative,'pg_ctl.exe'), ['-D',pgData,'-l',path.join(root,'postgres.log'),'-o',`-h 127.0.0.1 -p ${pgPort}`,'-w','start']);
    started = true;
    const roles = (await fs.readFile(path.join(backup,'roles.sql'),'utf8')).replace(/^CREATE ROLE postgres;\r?$/m,'');
    await sql(config, roles, { ...conn, database:'postgres' });
    for (const db of manifest.databases.filter(d => d.datname !== 'postgres')) {
      await run(path.join(config.pgTools,'pg_restore.exe'), ['-h','127.0.0.1','-p',String(pgPort),'-U','postgres','-d','postgres','--create','--exit-on-error',path.join(backup,db.file)], { env:pgEnv });
    }
    await sql(config, "UPDATE central.projects SET status='paused'; UPDATE project.config SET settings=settings || '{\"enginePaused\":true,\"testMode\":true}'::jsonb;", conn);
    for (const project of baseline.projects) {
      const target = contained(root,path.join(root,`projects/${project.id}`));
      await sql(config, `UPDATE central.projects SET path=${literal(target)} WHERE id=${literal(project.id)};`, conn);
    }
    const env = { ...process.env, HOME:profile, USERPROFILE:profile, APPDATA:path.join(profile,'AppData/Roaming'), LOCALAPPDATA:path.join(profile,'AppData/Local'), DATABASE_URL:`postgresql://postgres:password@127.0.0.1:${pgPort}/fusion`, FUSION_REHEARSAL_PG_PORT:String(pgPort), FUSION_LOCAL_CONTROL:control, FUSION_LOCAL_TOKEN:'rehearsal', FUSION_LOCAL_STANDALONE:'1', FUSION_SKIP_ONBOARDING:'1', NODE_OPTIONS:'' };
    const args = ['--import',pathToFileURL(path.join(here,'lifecycle.mjs')).href,'--import',pathToFileURL(path.join(here,'rehearsal-guard.mjs')).href,release.cli,'dashboard','--no-engine','--no-supervise','--no-auth','--host','127.0.0.1','--port',String(uiPort)];
    child = spawn(config.node,args,{ cwd:path.join(root,`projects/${baseline.projects[0].id}`), env, windowsHide:true, stdio:['ignore',out.fd,out.fd] });
    let spawnError;
    child.on('error',error=>{spawnError=error;});
    await waitUntil(async () => {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`Rehearsal exited ${child.exitCode}: ${root}/dashboard.log`);
      try { return (await api(`http://127.0.0.1:${uiPort}`,'/health')).status === 'ok'; } catch { return false; }
    },'isolated migrated dashboard',180_000);
    await assertWorkflowReferences(config,conn);
    const after = await inventory(config,conn);
    const result = compareInventory(baseline,after);
    await writeJson(path.join(root,'after-inventory.json'),after);
    const html = await fetch(`http://127.0.0.1:${uiPort}/`).then(r=>r.text());
    if (!html.includes('<script') || html.includes('Dashboard assets not built')) throw new Error('Dashboard client assets are missing');
    await writeJson(path.join(root,'result.json'), { ...result, release:release.id, backup, uiPort, pgPort, isolatedProfile:profile });
    console.log(`Migration rehearsal passed: ${root}`);
    return root;
  } finally {
    try {
      if (child?.pid && child.exitCode === null) {
        await writeJson(path.join(control,'stop.json'),{token:'rehearsal'});
        try {await waitUntil(()=>child.exitCode!==null,'rehearsal shutdown',45_000);}
        catch {child.kill();await waitUntil(()=>child.exitCode!==null||child.signalCode!==null,'isolated rehearsal termination',10_000);}
      }
    } finally {
      await out.close();
      if (started) await run(path.join(config.pgNative,'pg_ctl.exe'), ['-D',pgData,'-m','fast','-w','stop']);
    }
  }
}
