import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { acquireLock, archiveTree, checksums, contained, exists, here, isSourceFile, restoreSnapshot, run, verifyChecksums, waitUntil, writeJson } from './common.mjs';
import { compareInventory } from './backup.mjs';
import { build } from './build.mjs';
import { main, restoreCopies } from './manage.mjs';
/* global structuredClone */

// FNXC:LocalDeployment 2026-09-06-20:59: Exercise failed backups, duplicate operations, literal Windows arguments and preserved definitions using disposable data.
test('source snapshots reject ignored state and credential files',()=>{
  for(const rel of ['.fusion/settings.json','.env','dir/.env.production','node_modules/a.js','dist/app.js','id.key'])assert.equal(isSourceFile(rel),false,rel);
  for(const rel of ['packages/core/src/example.ts','scripts/fusion-local.ps1','new source.md'])assert.equal(isSourceFile(rel),true,rel);
});
test('rehearsal blocks network and command execution before application startup',async()=>{
  const code=`import assert from 'node:assert/strict';import net from 'node:net';import tls from 'node:tls';import cp from 'node:child_process';
    assert.throws(()=>net.connect(443,'example.com'),/isolated PostgreSQL/);
    assert.throws(()=>net.connect(4040,'127.0.0.1'),/isolated PostgreSQL/);
    assert.throws(()=>tls.connect(443,'example.com'),/blocks TLS/);
    const result=cp.spawnSync(process.execPath,['-e','process.stdout.write("SHOULD NOT RUN")'],{encoding:'utf8'});
    assert.equal(result.status,1);assert.equal(result.stdout,'');
    assert.equal(process.env.FUSION_TEST_DATABASE_URL,process.env.DATABASE_URL);`;
  await run(process.execPath,['--import',pathToFileURL(path.join(here,'rehearsal-guard.mjs')).href,'--input-type=module','-e',code],{env:{...process.env,DATABASE_URL:'postgresql://postgres:password@127.0.0.1:55443/fusion',FUSION_REHEARSAL_PG_PORT:'55443'}});
});
test('maintenance resume rejects unsafe phases and a different candidate before touching Windows',async()=>{
  const runtime=await fs.mkdtemp(path.join(os.tmpdir(),'fusion resume guard '));
  try {
    await writeJson(path.join(runtime,'config.json'),{runtime});
    await writeJson(path.join(runtime,'maintenance.json'),{});
    await writeJson(path.join(runtime,'journal.json'),{action:'activate',phase:'failed-after-activation',target:'candidate'});
    await assert.rejects(main(['Activate','--runtime',runtime,'--backup','unused']),/manual recovery/);
    await writeJson(path.join(runtime,'journal.json'),{action:'activate',phase:'backup',target:'candidate'});
    await assert.rejects(main(['Activate','--runtime',runtime,'--backup','unused','--release','different']),/original candidate/);
    assert.equal(await exists(path.join(runtime,'active.json')),false);
    assert.equal(await exists(path.join(runtime,'maintenance.json')),true);
  }finally{await fs.rm(runtime,{recursive:true,force:true});}
});
test('path validation rejects traversal and the root itself',()=>{
  const root=path.resolve('safe release');
  assert.throws(()=>contained(root,root));
  assert.throws(()=>contained(root,path.join(root,'../elsewhere')));
  assert.equal(contained(root,path.join(root,'child')),path.join(root,'child'));
});
test('backup corruption is detected before it can be used',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'fusion backup test '));
  try {
    await fs.writeFile(path.join(root,'data'),'original');
    const hashes=await checksums(root);
    await verifyChecksums(root,hashes);
    await fs.writeFile(path.join(root,'data'),'changed');
    await assert.rejects(verifyChecksums(root,hashes),/Checksum mismatch/);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
test('duplicate and interrupted operation locks fail closed',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'fusion lock test '));
  try {
    const release=await acquireLock(root);
    await assert.rejects(acquireLock(root),/Another operation/);
    await release();
    await writeJson(path.join(root,'operation.lock'),{pid:-1});
    await assert.rejects(acquireLock(root),/interrupted/);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
test('commands preserve spaced arguments and report failed builds',async()=>{
  assert.equal(await run(process.execPath,['-e','process.stdout.write(process.argv[1])','literal & spaces']), 'literal & spaces');
  await assert.rejects(run(process.execPath,['-e','process.exit(7)']),/exited 7/);
});
function sample(){return {projects:[{id:'p',name:'Project'}],counts:{'project.tasks':2,'project.agents':1},definitions:{agents:[{id:'a',project_id:'p',name:'Agent',data:{soul:'Keep this'}}],workflows:[{id:'WF-1',project_id:'p',name:'Workflow',kind:'workflow',ir:{nodes:['agent-a']}}],workflow_steps:[]}};}
test('missing records or changed authored definitions block activation',()=>{
  const before=sample();
  assert.doesNotThrow(()=>compareInventory(before,structuredClone(before)));
  const fewer=structuredClone(before);fewer.counts['project.tasks']=1;
  assert.throws(()=>compareInventory(before,fewer),/project.tasks/);
  const changed=structuredClone(before);changed.definitions.workflows[0].ir.nodes=[];
  assert.throws(()=>compareInventory(before,changed),/Changed workflows/);
  const agent=structuredClone(before);agent.definitions.agents[0].data.soul='lost';
  assert.throws(()=>compareInventory(before,agent),/Changed agent/);
});
test('an activated release cannot be overwritten by a build',async()=>{
  const runtime=await fs.mkdtemp(path.join(os.tmpdir(),'fusion active build '));
  try {
    await writeJson(path.join(runtime,'active.json'),{id:'stable'});
    await assert.rejects(build({runtime},'stable'),/Cannot rebuild an active/);
    assert.equal(await fs.readFile(path.join(runtime,'active.json'),'utf8'),JSON.stringify({id:'stable'},null,2)+'\n');
  }finally{await fs.rm(runtime,{recursive:true,force:true});}
});
test('a corrupt candidate cannot change the selected release or reach Windows task operations',async()=>{
  const runtime=await fs.mkdtemp(path.join(os.tmpdir(),'fusion failed activation '));
  try {
    const root=path.join(runtime,'releases/broken');
    await writeJson(path.join(runtime,'config.json'),{runtime});
    await writeJson(path.join(runtime,'active.json'),{id:'stable'});
    await fs.mkdir(path.join(root,'packages/cli/dist'),{recursive:true});
    await fs.writeFile(path.join(root,'packages/cli/dist/bin.js'),'tampered');
    await writeJson(path.join(root,'local-release.json'),{id:'broken',root,verified:true,artifactHashes:{'bin.js':'incorrect'}});
    await assert.rejects(main(['Activate','--runtime',runtime,'--release','broken']),/Checksum mismatch/);
    assert.equal(JSON.parse(await fs.readFile(path.join(runtime,'active.json'),'utf8')).id,'stable');
  }finally{await fs.rm(runtime,{recursive:true,force:true});}
});
test('managed dashboard shutdown runs its graceful handler',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'fusion lifecycle '));
  try {
    const entry=path.join(root,'fake-dashboard.mjs');
    await fs.writeFile(entry,"process.on('SIGTERM',()=>{console.log('gracefully closed database');process.exit(0)});setInterval(()=>{},1000);");
    const child=run(process.execPath,['--import',pathToFileURL(path.join(here,'lifecycle.mjs')).href,entry,'dashboard'],{env:{...process.env,FUSION_LOCAL_CONTROL:root,FUSION_LOCAL_TOKEN:'test',FUSION_LOCAL_STANDALONE:'1'},timeout:10_000});
    await waitUntil(()=>exists(path.join(root,'child.json')),'test dashboard preload',5000);
    await writeJson(path.join(root,'stop.json'),{token:'test'});
    assert.equal(await child,'gracefully closed database');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
if(process.platform==='win32') test('data rollback restores the backup and retains every displaced file',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'fusion rollback test '));
  try {
    const backup=path.join(root,'backup'),live=path.join(root,'live'),runtime=path.join(root,'runtime');
    await fs.mkdir(path.join(backup,'global'),{recursive:true});await fs.mkdir(live);
    await fs.writeFile(path.join(backup,'global/data'),'old state');await fs.writeFile(path.join(live,'data'),'new work');
    await writeJson(path.join(backup,'backup.json'),{cold:true,copies:[{source:live,destination:'global',kind:'global'}]});
    await writeJson(path.join(backup,'checksums.json'),await checksums(backup));await writeJson(path.join(backup,'verified.json'),{verified:true});
    await restoreCopies({runtime,dataHome:live},backup);
    assert.equal(await fs.readFile(path.join(live,'data'),'utf8'),'old state');
    const archived=(await fs.readdir(root)).find(name=>name.startsWith('live.before-fusion-restore-'));
    assert.equal(await fs.readFile(path.join(root,archived,'data'),'utf8'),'new work');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
if(process.platform==='win32') test('project archives preserve hidden data and uncommitted files through rehearsal and rollback',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'fusion archive spaces '));
  try {
    const live=path.join(root,'live project'),backup=path.join(root,'backup'),runtime=path.join(root,'runtime');
    await fs.mkdir(path.join(live,'.fusion'),{recursive:true});await fs.mkdir(path.join(live,'.git'));
    await fs.writeFile(path.join(live,'.fusion/memory'),'remember');await fs.writeFile(path.join(live,'.env'),'saved credential');await fs.writeFile(path.join(live,'working file.txt'),'uncommitted source');
    const copy={source:live,destination:'projects/p',archive:'projects/p.tar',kind:'project'};
    await archiveTree(live,path.join(backup,copy.archive));
    const rehearsal=path.join(root,'rehearsal');await restoreSnapshot(copy,backup,rehearsal,true);
    assert.equal(await fs.readFile(path.join(rehearsal,'.fusion/memory'),'utf8'),'remember');assert.equal(await exists(path.join(rehearsal,'.env')),false);
    await writeJson(path.join(backup,'backup.json'),{cold:true,copies:[copy]});await writeJson(path.join(backup,'checksums.json'),await checksums(backup));await writeJson(path.join(backup,'verified.json'),{});
    await fs.writeFile(path.join(live,'working file.txt'),'new work after backup');
    await restoreCopies({runtime,dataHome:path.join(root,'global')},backup);
    assert.equal(await fs.readFile(path.join(live,'.env'),'utf8'),'saved credential');assert.equal(await fs.readFile(path.join(live,'working file.txt'),'utf8'),'uncommitted source');assert.equal(await exists(path.join(live,'.git')),true);
    const displaced=(await fs.readdir(root)).find(name=>name.startsWith('live project.before-fusion-restore-'));
    assert.equal(await fs.readFile(path.join(root,displaced,'working file.txt'),'utf8'),'new work after backup');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
