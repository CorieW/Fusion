import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireLock, api, checksums, contained, exists, here, ps, readJson, restoreSnapshot, run, timestamp, verifyChecksums, waitUntil, writeJson } from './common.mjs';
import { assertIdle, assertWorkflowReferences, compareInventory, createBackup, inventory, pauseProjects, resumeProjects, verifyBackup } from './backup.mjs';
import { build } from './build.mjs';
import { rehearse } from './rehearse.mjs';
import { verify } from './verify.mjs';

// FNXC:LocalDeployment 2026-09-06-20:56: A journal and maintenance marker fence activation; data-changing rollback preserves the displaced state before restoring a matching backup.
export async function stopFusion(config) {
  const state = JSON.parse(await ps('Inspect'));
  if (!state.processes.length) return;
  const managed = state.processes.some(p=>p.CommandLine.includes(config.runtime));
  if (managed) {
    const child = await readJson(path.join(config.runtime,'child.json'));
    if (!state.processes.some(p=>p.ProcessId===child.pid && p.ParentProcessId===child.parent)) throw new Error('Managed dashboard identity mismatch');
    await writeJson(path.join(config.runtime,'stop.json'),{token:child.token});
    await waitUntil(async()=>!(JSON.parse(await ps('Inspect'))).processes.length,'managed Fusion graceful shutdown',60_000);
  } else {
    const child = state.processes.find(p=>state.processes.some(parent=>parent.ProcessId===p.ParentProcessId));
    if (!child || state.processes.length!==2) throw new Error('Cannot unambiguously identify the legacy supervisor and child');
    // Freeze only the supervisor while the existing HTTP restart endpoint gracefully drains the child. This avoids its automatic respawn during migration.
    await ps('SuspendLegacy',['-ProcessId',String(child.ParentProcessId)]);
    try {
      await api(config.url,'/system/restart',{method:'POST',body:{reason:'local-deployment-maintenance'}});
      await waitUntil(async()=>!(JSON.parse(await ps('Inspect'))).processes.some(p=>p.ProcessId===child.ProcessId),'legacy child graceful shutdown',60_000);
      await ps('StopLegacyParent',['-ProcessId',String(child.ParentProcessId)]);
    } catch(e) { await ps('ResumeLegacy',['-ProcessId',String(child.ParentProcessId)]).catch(()=>{}); throw e; }
  }
  const cluster = path.join(config.dataHome,'embedded-postgres/default');
  if (await exists(path.join(cluster,'postmaster.pid'))) {
    const ctl=path.join(config.pgNative,'pg_ctl.exe');
    try { await run(ctl,['-D',cluster,'-m','fast','-w','stop']); }
    catch(error) {
      // FNXC:LocalDeployment 2026-09-06-21:41: embedded-postgres uses taskkill on Windows. Recover its stopped cluster offline, then checkpoint through pg_ctl before copying data.
      const status=await run(ctl,['-D',cluster,'status']).then(()=>true,()=>false);
      if(status)throw error;
      if((JSON.parse(await ps('Inspect'))).processes.length)throw new Error('Fusion restarted during database shutdown');
      const lines=(await fs.readFile(path.join(cluster,'postmaster.pid'),'utf8')).split(/\r?\n/);
      const port=Number(lines[3]);
      if(!Number.isInteger(port)||port<1024||port>65535)throw error;
      console.log('Checkpointing the stopped embedded database before the cold snapshot.');
      await run(ctl,['-D',cluster,'-l',path.join(config.runtime,`database-checkpoint-${timestamp()}.log`),'-o',`-h 127.0.0.1 -p ${port}`,'-w','start']);
      await run(ctl,['-D',cluster,'-m','fast','-w','stop']);
    }
  }
  if (await exists(path.join(cluster,'postmaster.pid'))) throw new Error('PostgreSQL is not cleanly stopped');
}
async function startFusion(config) {
  await fs.rm(path.join(config.runtime,'maintenance.json'),{force:true});
  await fs.rm(path.join(config.runtime,'stop.json'),{force:true});
  await ps('Start');
  await waitUntil(async()=>{ try { return (await api(config.url,'/health')).status==='ok'; } catch { return false; } },'Fusion dashboard',180_000);
}
async function installLauncher(config) {
  for (const name of ['start.ps1','lifecycle.mjs']) await fs.copyFile(path.join(here,name),path.join(config.runtime,name));
  await ps('Register',['-RuntimeRoot',config.runtime]);
}
export async function restoreCopies(config, backup) {
  const manifest = await verifyBackup(backup);
  if (!manifest.cold) throw new Error('A data rollback requires a cold backup');
  const displaced = [];
  for (const copy of manifest.copies) {
    contained(backup,path.join(backup,copy.archive??copy.destination));
    const original = path.resolve(copy.source);
    const allowed = copy.kind==='global' ? original===path.resolve(config.dataHome) : manifest.copies.some(c=>c.kind!=='global' && path.resolve(c.source)===original);
    if (!allowed || original===path.parse(original).root || original.toLowerCase()===os.homedir().toLowerCase()) throw new Error(`Unsafe restore target ${original}`);
    const archived = `${original}.before-fusion-restore-${timestamp()}`;
    if (await exists(original)) { await fs.rename(original,archived); displaced.push({original,archived}); }
    await restoreSnapshot(copy,backup,original);
  }
  await writeJson(path.join(config.runtime,`restore-${timestamp()}.json`),{backup,displaced});
  return manifest;
}
// FNXC:LocalDeployment 2026-09-06-22:07: Resume a stopped, pre-migration activation only when the verified cold backup still matches the live global data byte for byte.
export async function resumeActivation(config, backup, requestedRelease, verifiedManifest) {
  const runtime=config.runtime;
  const journal=await readJson(path.join(runtime,'journal.json'));
  // FNXC:LocalDeployment 2026-09-08-12:44: Deploy and Activate share the same pre-migration resume boundary and all existing cold-backup and process checks.
  if(!['activate','deploy'].includes(journal.action)||!['backup','backed-up'].includes(journal.phase))throw new Error('This maintenance phase requires manual recovery; automatic activation resume is unsafe');
  if(requestedRelease&&requestedRelease!==journal.target)throw new Error('Resume must use the original candidate');
  const state=JSON.parse(await ps('Inspect'));
  if(state.enabled||state.processes.length)throw new Error('Resume requires the startup task disabled and all Fusion processes stopped');
  if(await exists(path.join(config.dataHome,'embedded-postgres/default/postmaster.pid')))throw new Error('Resume requires PostgreSQL to be stopped');
  const manifest=verifiedManifest??await verifyBackup(backup);
  if(!manifest.cold||manifest.release?.id!==journal.previous.id)throw new Error('Resume backup must match the previous release');
  if(!manifest.copies.some(c=>c.kind==='global'&&path.resolve(c.source)===path.resolve(config.dataHome)))throw new Error('Resume backup has a different production data directory');
  const hashes=await readJson(path.join(backup,'checksums.json'));
  const globalHashes=Object.fromEntries(Object.entries(hashes).filter(([name])=>/^global[/\\]/.test(name)).map(([name,hash])=>[name.slice(7),hash]));
  if(!Object.keys(globalHashes).length)throw new Error('Resume backup has no global data');
  await verifyChecksums(config.dataHome,globalHashes);
  const release=await readJson(path.join(contained(path.join(runtime,'releases'),path.join(runtime,'releases',journal.target)),'local-release.json'));
  if(!release.verified)throw new Error('Resume candidate has not passed its checks');
  await verifyChecksums(path.join(release.root,'packages/cli/dist'),release.artifactHashes);
  journal.backup=backup;journal.phase='backed-up';await writeJson(path.join(runtime,'journal.json'),journal);
  let started=false;
  try {
    journal.rehearsal=await rehearse(config,release,backup,manifest);
    journal.phase='activating';await writeJson(path.join(runtime,'journal.json'),journal);
    await installLauncher(config);
    await writeJson(path.join(runtime,'active.json'),{id:release.id,cli:release.cli,schemaHashes:release.schemaHashes,activatedAt:new Date().toISOString(),backup});
    started=true;
    await startFusion(config);
    const live=JSON.parse(await ps('Inspect'));
    if(live.processes.length!==2||live.processes.some(p=>!p.CommandLine.includes(release.cli)))throw new Error('Running processes do not match the resumed candidate');
    const report=compareInventory(await readJson(path.join(backup,'inventory.json')),await inventory(config));
    await writeJson(path.join(runtime,`acceptance-${release.id}.json`),report);
    await resumeProjects(config,journal.projects,journal.pauseSettings);
    await fs.rm(path.join(runtime,'drain.json'),{force:true});
    journal.phase='complete';journal.completedAt=new Date().toISOString();delete journal.error;
    await writeJson(path.join(runtime,'journal.json'),journal);
    console.log(`Active Fusion: ${release.id}\nBackup: ${backup}\nDashboard: ${config.url}`);
  } catch(error) {
    journal.phase=started?'failed-after-activation':'backed-up';journal.error=error.message;
    await writeJson(path.join(runtime,'journal.json'),journal);
    await writeJson(path.join(runtime,'maintenance.json'),{error:error.message});await ps('Disable');
    throw error;
  }
}
// FNXC:LocalDeployment 2026-09-08-12:30: Offline recovery is an explicit operator operation. Require a matching journal/backup and stopped processes; never depend on a broken dashboard or bypass a live maintenance operation.
export async function offlineRollback(config, backup, releaseId, overrides = {}) {
  const ops = { ps, verifyBackup, restoreCopies, installLauncher, startFusion, inventory, resumeProjects, ...overrides };
  const runtime = config.runtime;
  if (!backup || !releaseId || !await exists(path.join(runtime,'maintenance.json'))) throw new Error('Offline rollback requires --release, --backup, --restore-data and an existing maintenance marker');
  const journal = await readJson(path.join(runtime,'journal.json'));
  if (!['activating','failed-after-activation','failed-during-data-restore','offline-restoring','offline-starting'].includes(journal.phase)) throw new Error('Journal phase is not eligible for offline rollback');
  if (journal.previous?.id !== releaseId || !journal.backup || path.resolve(journal.backup).toLowerCase() !== path.resolve(backup).toLowerCase()) throw new Error('Offline rollback must use the journal previous release and matching cold backup');
  const manifest = await ops.verifyBackup(backup);
  if (!manifest.cold || manifest.release?.id !== releaseId || !manifest.copies.some(copy => copy.kind === 'global' && path.resolve(copy.source).toLowerCase() === path.resolve(config.dataHome).toLowerCase())) throw new Error('Offline rollback backup does not match this installation');
  const release = await readJson(releaseId === 'legacy-0.76.0' ? path.join(runtime,'legacy.json') : path.join(contained(path.join(runtime,'releases'),path.join(runtime,'releases',releaseId)),'local-release.json'));
  if (!release.verified || !release.artifactHashes || !Object.keys(release.artifactHashes).length) throw new Error('Previous release has no verified artifacts');
  await verifyChecksums(release.dist ?? path.join(release.root,'packages/cli/dist'),release.artifactHashes);
  const state = JSON.parse(await ops.ps('Inspect'));
  if (state.enabled || state.processes.length || await exists(path.join(config.dataHome,'embedded-postgres/default/postmaster.pid'))) throw new Error('Offline rollback requires the startup task disabled and Fusion and PostgreSQL stopped');
  try {
    journal.phase='offline-restoring'; await writeJson(path.join(runtime,'journal.json'),journal);
    await ops.restoreCopies(config,backup);
    await ops.installLauncher(config);
    await writeJson(path.join(runtime,'active.json'),{id:release.id,cli:release.cli,schemaHashes:release.schemaHashes,backup,activatedAt:new Date().toISOString()});
    journal.phase='offline-starting'; await writeJson(path.join(runtime,'journal.json'),journal);
    await ops.startFusion(config);
    const live=JSON.parse(await ops.ps('Inspect'));
    if (live.processes.length!==2 || live.processes.some(p=>!p.CommandLine.includes(release.cli))) throw new Error('Recovered processes do not match the previous release');
    const report=compareInventory(await readJson(path.join(backup,'inventory.json')),await ops.inventory(config));
    await writeJson(path.join(runtime,`acceptance-${release.id}.json`),report);
    await ops.resumeProjects(config,manifest.resumeProjects,manifest.pauseSettings);
    await fs.rm(path.join(runtime,'drain.json'),{force:true});
    journal.phase='complete'; journal.completedAt=new Date().toISOString(); delete journal.error;
    await writeJson(path.join(runtime,'journal.json'),journal);
  } catch(error) {
    journal.error=error.message; await writeJson(path.join(runtime,'journal.json'),journal);
    await writeJson(path.join(runtime,'maintenance.json'),{error:error.message}); await ops.ps('Disable');
    throw error;
  }
}
export async function main(argv=process.argv.slice(2)) {
  const action=(argv[0]??'Status').toLowerCase();
  const option = name=>{const i=argv.indexOf(name);return i<0?undefined:argv[i+1];};
  const runtime=path.resolve(option('--runtime')??'A:\\Custom Fusion Runtime');
  const configFile=path.join(runtime,'config.json');
  await fs.mkdir(runtime,{recursive:true});
  const config=await exists(configFile)?await readJson(configFile):{
    runtime,backups:path.resolve(option('--backups')??'A:\\Fusion Backup Data'),node:process.execPath,url:'http://127.0.0.1:4040',dataHome:path.join(os.homedir(),'.fusion'),workingDirectory:await ps('WorkingDirectory'),
    pgTools:'C:\\Program Files\\PostgreSQL\\16\\bin',pgNative:path.join(os.homedir(),'AppData/Local/RunFusion/node_modules/@embedded-postgres/windows-x64/native/bin'),legacyLauncher:path.join(os.homedir(),'AppData/Local/RunFusion/start-runfusion.ps1'),legacyCli:path.join(os.homedir(),'AppData/Local/RunFusion/node_modules/@runfusion/fusion/bin.mjs'),
  };
  if (!await exists(configFile)) await writeJson(configFile,config);
  if (action==='status') {
    const selected=await exists(path.join(runtime,'active.json'))?await readJson(path.join(runtime,'active.json')):{id:'legacy-0.76.0',cli:config.legacyCli};
    const saved=await exists(path.join(runtime,'journal.json'))?await readJson(path.join(runtime,'journal.json')):null;
    const journal=saved?{action:saved.action,phase:saved.phase,previous:saved.previous?.id,target:saved.target,backup:saved.backup,rehearsal:saved.rehearsal,error:saved.error,startedAt:saved.startedAt,completedAt:saved.completedAt}:null;
    console.log(JSON.stringify({active:{id:selected.id,cli:selected.cli,activatedAt:selected.activatedAt,backup:selected.backup},task:JSON.parse(await ps('Inspect')),maintenance:await exists(path.join(runtime,'maintenance.json')),journal},null,2));return;
  }
  const unlock=await acquireLock(runtime);
  try {
    if (action==='build') {await build(config,option('--release'));return;}
    if (action==='verify') {await verify(config,option('--release'));return;}
    if (action === 'rollback' && argv.includes('--offline')) {
      if (!argv.includes('--restore-data')) throw new Error('Offline rollback requires --restore-data');
      await offlineRollback(config,option('--backup'),option('--release')); return;
    }
    if (await exists(path.join(runtime,'maintenance.json'))) {
      if(action==='activate'&&option('--backup')) {await resumeActivation(config,option('--backup'),option('--release'));return;}
      throw new Error('An interrupted maintenance operation needs recovery. Inspect Status and journal.json before continuing.');
    }
    let release;
    if (action==='deploy') release=await build(config,option('--release'));
    if (action==='activate'||action==='rollback') {
      const id=option('--release')??(await readJson(path.join(runtime,'candidate.json'))).id;
      if(id==='legacy-0.76.0') release=await readJson(path.join(runtime,'legacy.json'));
      else {
        const releasePath=contained(path.join(runtime,'releases'),path.join(runtime,'releases',id));
        release=await readJson(path.join(releasePath,'local-release.json'));
      }
    }
    if (release) {
      if (!release.verified) throw new Error('Release has not passed its checks');
      await verifyChecksums(release.dist??path.join(release.root,'packages/cli/dist'),release.artifactHashes);
    }
    if(!await exists(path.join(runtime,'legacy.json'))) {
      const dist=path.join(path.dirname(config.legacyCli),'dist');
      await writeJson(path.join(runtime,'legacy.json'),{id:'legacy-0.76.0',cli:config.legacyCli,dist,verified:true,artifactHashes:await checksums(dist),schemaHashes:await checksums(path.join(dist,'migrations'))});
    }
    const previous=await exists(path.join(runtime,'active.json'))?await readJson(path.join(runtime,'active.json')):await readJson(path.join(runtime,'legacy.json'));
    if (action==='rollback'&&!argv.includes('--restore-data')) {
      if (!previous.schemaHashes || JSON.stringify(previous.schemaHashes)!==JSON.stringify(release.schemaHashes)) throw new Error('Schema compatibility is unproven. Use --restore-data with an explicit matching backup.');
    }
    if (action === 'activate' || action === 'deploy') await assertWorkflowReferences(config);
    const projects=await api(config.url,'/projects');
    const pauseSettings=[];
    // FNXC:LocalDeployment 2026-09-06-21:29: Soft engine pause prevents fresh timer dispatch while existing work finishes; project engines are stopped only after the idle checks pass.
    try {
      for(const project of projects) {
        const settings=await api(config.url,'/settings',{project:project.id});
        pauseSettings.push({id:project.id,enginePaused:settings.enginePaused===true});
      }
      await writeJson(path.join(runtime,'drain.json'),{projects,pauseSettings,startedAt:new Date().toISOString()});
      for(const saved of pauseSettings)await api(config.url,'/settings',{method:'PUT',project:saved.id,body:{enginePaused:true}});
      console.log('New automatic dispatch paused; waiting for existing work to finish.');
      await waitUntil(async()=>{try{await assertIdle(config);return true;}catch(e){if(e.message.startsWith('Activation pending:'))return false;throw e;}},'active work to finish (activation remains pending)',10*60_000);
    } catch(e) {
      for(const saved of pauseSettings)await api(config.url,'/settings',{method:'PUT',project:saved.id,body:{enginePaused:saved.enginePaused}});
      await fs.rm(path.join(runtime,'drain.json'),{force:true});
      throw e;
    }
    const journal={action,phase:'pausing',previous,target:release?.id,projects,pauseSettings,startedAt:new Date().toISOString()};
    await writeJson(path.join(runtime,'journal.json'),journal);
    let candidateStarted=false, dataRestoreStarted=false, backup;
    try {
      await pauseProjects(config,projects);
      await writeJson(path.join(runtime,'maintenance.json'),{startedAt:new Date().toISOString()});
      await ps('Disable');
      journal.phase='backup';await writeJson(path.join(runtime,'journal.json'),journal);
      backup=await createBackup(config,{cold:true,stop:()=>stopFusion(config),release:previous,projects,pauseSettings,onCreated:async folder=>{journal.backup=folder;await writeJson(path.join(runtime,'journal.json'),journal);}});
      journal.backup=backup;journal.phase='backed-up';await writeJson(path.join(runtime,'journal.json'),journal);
      if(action==='backup') {await startFusion(config);await resumeProjects(config,projects,pauseSettings);await fs.rm(path.join(runtime,'drain.json'),{force:true});journal.phase='complete';await writeJson(path.join(runtime,'journal.json'),journal);console.log(`Verified cold backup: ${backup}`);return;}
      let expectedBackup=backup;
      let resumeState=projects;
      let resumeSettings=pauseSettings;
      if(action==='rollback'&&argv.includes('--restore-data')) {
        const requested=option('--backup');
        if(!requested)throw new Error('Specify --backup for data rollback');
        const old=await verifyBackup(requested);
        if(old.release?.id!==release.id)throw new Error('Backup does not match the requested release');
        dataRestoreStarted=true;
        await restoreCopies(config,requested);
        expectedBackup=requested;
        resumeState=old.resumeProjects;
        resumeSettings=old.pauseSettings;
      } else {
        journal.rehearsal=await rehearse(config,release,backup,await readJson(path.join(backup,'backup.json')));
      }
      journal.phase='activating';await writeJson(path.join(runtime,'journal.json'),journal);
      await installLauncher(config);
      await writeJson(path.join(runtime,'active.json'),{id:release.id,cli:release.cli,schemaHashes:release.schemaHashes,activatedAt:new Date().toISOString(),backup});
      candidateStarted=true;
      await startFusion(config);
      const live=JSON.parse(await ps('Inspect'));
      if(live.processes.length!==2||live.processes.some(p=>!p.CommandLine.includes(release.cli)))throw new Error('Running supervisor and dashboard do not match the selected release');
      const before=await readJson(path.join(expectedBackup,'inventory.json'));
      const after=await inventory(config);
      const report=compareInventory(before,after);
      await writeJson(path.join(runtime,`acceptance-${release.id}.json`),report);
      await resumeProjects(config,resumeState,resumeSettings);
      await fs.rm(path.join(runtime,'drain.json'),{force:true});
      journal.phase='complete';journal.completedAt=new Date().toISOString();await writeJson(path.join(runtime,'journal.json'),journal);
      console.log(`Active Fusion: ${release.id}\nBackup: ${backup}\nDashboard: ${config.url}`);
    } catch(e) {
      journal.error=e.message;journal.phase=candidateStarted?'failed-after-activation':dataRestoreStarted?'failed-during-data-restore':'failed-before-activation';await writeJson(path.join(runtime,'journal.json'),journal);
      if(!candidateStarted&&!dataRestoreStarted) {await startFusion(config);await resumeProjects(config,projects,pauseSettings);await fs.rm(path.join(runtime,'drain.json'),{force:true});}
      else {await writeJson(path.join(runtime,'maintenance.json'),{error:e.message});await ps('Disable');console.error('Candidate remains paused. The matching backup and journal are retained for recovery; no data was overwritten.');}
      throw e;
    }
  } finally {await unlock();}
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) main().catch(e=>{console.error(e.message);process.exitCode=1;});
