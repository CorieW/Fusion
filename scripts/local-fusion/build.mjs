import * as fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { checksums, contained, copyTree, exists, hashFile, isSourceFile, readJson, run, sourceRoot, timestamp, writeJson } from './common.mjs';

// FNXC:LocalDeployment 2026-09-06-20:56: Build snapshots include uncommitted source, use the upstream lockfile, and never overwrite the active release.
export async function build(config, id) {
  id ??= `${timestamp()}-${(await run('git.exe',['rev-parse','--short=12','HEAD'],{cwd:sourceRoot}))}`;
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid release ID');
  const root = contained(path.join(config.runtime,'releases'),path.join(config.runtime,'releases',id));
  const activeFile = path.join(config.runtime,'active.json');
  if (await exists(activeFile) && (await readJson(activeFile)).id === id) throw new Error('Cannot rebuild an active release');
  await fs.mkdir(root,{recursive:true});
  if (!await exists(path.join(root,'.git'))) {
    const gitCopy = path.join(config.runtime,`git-snapshot-${timestamp()}`);
    await run('git.exe',['clone','--no-checkout','--no-hardlinks','--local',sourceRoot,gitCopy]);
    await fs.rename(path.join(gitCopy,'.git'),path.join(root,'.git'));
    await fs.rmdir(gitCopy);
  }
  const sourceCommit = await run('git.exe',['rev-parse','HEAD'],{cwd:sourceRoot});
  await run('git.exe',['read-tree',sourceCommit],{cwd:root});
  const currentPaths = (await run('git.exe',['ls-files','-z','--cached','--others','--exclude-standard'],{cwd:sourceRoot})).split('\0');
  const committedPaths = (await run('git.exe',['ls-files','-z'],{cwd:root})).split('\0');
  const selected = [...new Set([...currentPaths,...committedPaths])].filter(Boolean).filter(isSourceFile);
  const sourceHashes = {};
  for (const rel of selected) {
    const from = contained(sourceRoot,path.join(sourceRoot,rel));
    const to = contained(root,path.join(root,rel));
    if (!await exists(from)) { if (await exists(to)) await fs.unlink(to); continue; }
    if ((await fs.lstat(from)).isSymbolicLink()) throw new Error(`Source symlink needs explicit packaging support: ${rel}`);
    await fs.mkdir(path.dirname(to),{recursive:true});
    await fs.copyFile(from,to);
    sourceHashes[rel] = await hashFile(to);
  }
  // FNXC:LocalDeployment 2026-09-07-01:53: Static gates inspect Git's index. Stage precisely the isolated source snapshot so deleted presets disappear and new source files are covered, including uncommitted edits.
  const indexPaths=path.join(config.runtime,`source-index-${id}.paths`);
  await fs.writeFile(indexPaths,selected.join('\0')+'\0');
  try { await run('git.exe',['--literal-pathspecs','add','--all',`--pathspec-from-file=${indexPaths}`,'--pathspec-file-nul'],{cwd:root}); }
  finally { await fs.unlink(indexPaths); }
  const localChanges=(await run('git.exe',['diff','--name-only','-z','HEAD'],{cwd:sourceRoot})).split('\0').filter(Boolean).filter(isSourceFile);
  const untracked=(await run('git.exe',['ls-files','--others','--exclude-standard','-z'],{cwd:sourceRoot})).split('\0').filter(Boolean).filter(isSourceFile);
  const manifest = { format:1,id,root,sourceCommit,localChanges,untracked,createdAt:new Date().toISOString(),node:process.version,pnpm:'10.33.0',cli:path.join(root,'packages/cli/bin.mjs'),sourceHashes,verified:false };
  await writeJson(path.join(root,'local-release.json'),manifest);
  const logRoot = path.join(config.runtime,'logs',id);
  await fs.mkdir(logRoot,{recursive:true});
  const corepack = path.join(path.dirname(config.node),'node_modules/corepack/dist/pnpm.js');
  const step = async (name,args,env=process.env) => {
    console.log(`${id}: ${name}; log: ${path.join(logRoot,`${name}.log`)}`);
    await run(config.node,[corepack,...args],{cwd:root,env,log:path.join(logRoot,`${name}.log`),timeout:60*60_000});
  };
  await step('install',['install','--frozen-lockfile']);
  await step('build',['build:full']);
  const isolatedHome = path.join(config.runtime,'test-homes',id);
  await fs.mkdir(isolatedHome,{recursive:true});
  const testEnv = { ...process.env, HOME:isolatedHome,USERPROFILE:isolatedHome,APPDATA:path.join(isolatedHome,'AppData/Roaming'),LOCALAPPDATA:path.join(isolatedHome,'AppData/Local'),FUSION_SKIP_ONBOARDING:'1' };
  // FNXC:LocalDeployment 2026-09-06-21:19: The upstream gate uses POSIX assignments and shell groups; run those scripts through installed Git Bash on Windows.
  testEnv.npm_config_script_shell='C:\\Program Files\\Git\\bin\\bash.exe';
  const pathKey=Object.keys(testEnv).find(k=>k.toLowerCase()==='path')??'PATH';
  testEnv[pathKey]=`C:\\Program Files\\Git\\usr\\bin;${testEnv[pathKey]??''}`;
  for (const key of Object.keys(testEnv)) if (/DATABASE_URL|^PG(HOST|PORT|USER|PASSWORD|DATABASE)$|^FUSION_LOCAL_|^FUSION_.*(DB|POSTGRES)/.test(key)) delete testEnv[key];
  const checks = {};
  for (const [name,args] of [['lint',['lint']],['typecheck',['typecheck']]]) {
    try { await step(name,args,testEnv); checks[name] = 'passed'; }
    catch (e) { checks[name] = e.message; }
  }
  // FNXC:LocalDeployment 2026-09-06-21:06: Gate tests must never discover an unrelated PostgreSQL service on the default port.
  const pgData=path.join(isolatedHome,`gate-postgres-${timestamp()}`);
  const pgPort=await new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port));});});
  await run(path.join(config.pgNative,'initdb.exe'),['-D',pgData,'-U','postgres','--auth=trust','--encoding=UTF8','--locale=C']);
  await run(path.join(config.pgNative,'pg_ctl.exe'),['-D',pgData,'-l',path.join(isolatedHome,'gate-postgres.log'),'-o',`-h 127.0.0.1 -p ${pgPort}`,'-w','start']);
  try {
    testEnv.FUSION_PG_TEST_URL_BASE=`postgresql://postgres@127.0.0.1:${pgPort}`;
    try {await step('gate',['test:gate'],testEnv);checks.gate='passed';}catch(e){checks.gate=e.message;}
  } finally {await run(path.join(config.pgNative,'pg_ctl.exe'),['-D',pgData,'-m','fast','-w','stop']);}
  try {await step('boot',['smoke:boot'],testEnv);checks.boot='passed';}catch(e){checks.boot=e.message;}
  manifest.checks = checks;
  manifest.lockfileHash = await hashFile(path.join(root,'pnpm-lock.yaml'));
  manifest.artifactHashes = await checksums(path.join(root,'packages/cli/dist'));
  manifest.schemaHashes = await checksums(path.join(root,'packages/cli/dist/migrations'));
  manifest.verified = Object.values(checks).every(x=>x==='passed');
  await writeJson(path.join(root,'local-release.json'),manifest);
  if (!manifest.verified) throw new Error(`Candidate checks failed. Inspect ${logRoot}; active Fusion is unchanged.`);
  await writeJson(path.join(config.runtime,'candidate.json'),{id});
  console.log(`Verified candidate: ${id}`);
  return manifest;
}
