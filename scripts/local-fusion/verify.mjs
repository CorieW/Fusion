import * as fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { contained, readJson, run, timestamp, verifyChecksums, writeJson } from './common.mjs';

// FNXC:LocalDeployment 2026-09-06-21:19: Retest a failed candidate without rebuilding already verified application artifacts or repeating successful checks.
export async function verify(config,id) {
  const root=contained(path.join(config.runtime,'releases'),path.join(config.runtime,'releases',id));
  const file=path.join(root,'local-release.json');
  const manifest=await readJson(file);
  if(!manifest.artifactHashes)throw new Error('Build did not finish; use Build first');
  await verifyChecksums(path.join(root,'packages/cli/dist'),manifest.artifactHashes);
  const home=path.join(config.runtime,'test-homes',id);
  const env={...process.env,HOME:home,USERPROFILE:home,APPDATA:path.join(home,'AppData/Roaming'),LOCALAPPDATA:path.join(home,'AppData/Local'),npm_config_script_shell:'C:\\Program Files\\Git\\bin\\bash.exe',FUSION_SKIP_ONBOARDING:'1'};
  for(const key of Object.keys(env))if(/DATABASE_URL|^PG(HOST|PORT|USER|PASSWORD|DATABASE)$|^FUSION_LOCAL_|^FUSION_.*(DB|POSTGRES)/.test(key))delete env[key];
  const pathKey=Object.keys(env).find(k=>k.toLowerCase()==='path')??'PATH';
  env[pathKey]=`C:\\Program Files\\Git\\usr\\bin;${env[pathKey]??''}`;
  const corepack=path.join(path.dirname(config.node),'node_modules/corepack/dist/pnpm.js');
  for(const [name,command] of [['lint','lint'],['typecheck','typecheck'],['gate','test:gate'],['boot','smoke:boot']]) {
    if(manifest.checks?.[name]==='passed')continue;
    let pgData;
    try {
      if(name==='gate') {
        pgData=path.join(home,`verify-postgres-${timestamp()}`);
        const port=await new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
        await run(path.join(config.pgNative,'initdb.exe'),['-D',pgData,'-U','postgres','--auth=trust','--encoding=UTF8','--locale=C']);
        await run(path.join(config.pgNative,'pg_ctl.exe'),['-D',pgData,'-l',path.join(home,`verify-pg-${timestamp()}.log`),'-o',`-h 127.0.0.1 -p ${port}`,'-w','start']);
        env.FUSION_PG_TEST_URL_BASE=`postgresql://postgres@127.0.0.1:${port}`;
      }
      const log=path.join(config.runtime,'logs',id,`${name}-verify.log`);
      console.log(`Verifying ${name}: ${log}`);
      await run(config.node,[corepack,command],{cwd:root,env,log,timeout:60*60_000});
      manifest.checks[name]='passed';
    } catch(e) {manifest.checks[name]=e.message;}
    finally {
      if(pgData)await run(path.join(config.pgNative,'pg_ctl.exe'),['-D',pgData,'-m','fast','-w','stop']);
      await writeJson(file,manifest);
    }
  }
  manifest.verified=['lint','typecheck','gate','boot'].every(name=>manifest.checks?.[name]==='passed');
  await writeJson(file,manifest);
  if(!manifest.verified)throw new Error('Candidate checks still fail; see its manifest and logs');
  await writeJson(path.join(config.runtime,'candidate.json'),{id});
  console.log(`Verified candidate: ${id}`);
}
