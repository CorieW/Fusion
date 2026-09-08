import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { offlineRollback } from './manage.mjs';
import { checksums, writeJson } from './common.mjs';
async function fixture(run) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'fusion-offline-test-'));
 try {
  const config={runtime:path.join(root,'runtime'),dataHome:path.join(root,'data')}; const backup=path.join(root,'backup');
  const dist=path.join(config.runtime,'releases/old/packages/cli/dist');await fs.mkdir(dist,{recursive:true});await fs.writeFile(path.join(dist,'sentinel'),'old release');
  const release={id:'old',root:path.join(config.runtime,'releases/old'),cli:'old-cli',verified:true,artifactHashes:await checksums(dist)};
  const inventory={settings:[],projects:[],counts:{},definitions:{agents:[],workflows:[],workflow_steps:[]}};
  await writeJson(path.join(release.root,'local-release.json'),release);await writeJson(path.join(backup,'inventory.json'),inventory);
  await writeJson(path.join(config.runtime,'journal.json'),{phase:'failed-after-activation',previous:{id:'old'},backup});await writeJson(path.join(config.runtime,'maintenance.json'),{});
  const events=[];let started=false;
  const ops={verifyBackup:async()=>({cold:true,release,copies:[{kind:'global',source:config.dataHome}],resumeProjects:[],pauseSettings:[]}),ps:async action=>{events.push(action);return JSON.stringify({enabled:false,processes:started?[{CommandLine:'old-cli'},{CommandLine:'old-cli'}]:[]});},restoreCopies:async()=>events.push('restore'),installLauncher:async()=>events.push('install'),startFusion:async()=>{started=true;events.push('start');},inventory:async()=>inventory,resumeProjects:async()=>events.push('resume')};
  await run({config,backup,ops,events});
 }finally{await fs.rm(root,{recursive:true,force:true});}
}
test('offline rollback restores before startup without needing a live API',()=>fixture(async({config,backup,ops,events})=>{
 await offlineRollback(config,backup,'old',ops);assert.deepEqual(events,['Inspect','restore','install','start','Inspect','resume']);
 assert.equal(JSON.parse(await fs.readFile(path.join(config.runtime,'journal.json'))).phase,'complete');
}));
test('live process or enabled task refuses restoration',()=>fixture(async({config,backup,ops,events})=>{
 ops.ps=async()=>JSON.stringify({enabled:true,processes:[]});await assert.rejects(offlineRollback(config,backup,'old',ops),/stopped/);assert.deepEqual(events,[]);
}));
test('wrong backup refuses restoration',()=>fixture(async({config,backup,ops,events})=>{
 await assert.rejects(offlineRollback(config,backup+'-wrong','old',ops),/matching cold backup/);assert.deepEqual(events,[]);
}));
test('restore failure keeps maintenance and disables startup',()=>fixture(async({config,backup,ops,events})=>{
 ops.restoreCopies=async()=>{throw new Error('disk full');};await assert.rejects(offlineRollback(config,backup,'old',ops),/disk full/);
 assert.ok(await fs.stat(path.join(config.runtime,'maintenance.json')));assert.equal(events.at(-1),'Disable');assert.ok(!events.includes('start'));
}));
