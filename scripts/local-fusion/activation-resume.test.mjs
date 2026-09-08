import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {resumeActivation} from './manage.mjs';
import {writeJson} from './common.mjs';
test('Activate and Deploy admit the same pre-migration phases but still enforce candidate identity',async t=>{
 const runtime=await fs.mkdtemp(path.join(os.tmpdir(),'fusion-resume-test-'));t.after(()=>fs.rm(runtime,{recursive:true,force:true}));
 for(const action of ['activate','deploy'])for(const phase of ['backup','backed-up']){
  await writeJson(path.join(runtime,'journal.json'),{action,phase,target:'original'});
  await assert.rejects(resumeActivation({runtime},'unused','different'),/original candidate/);
 }
 for(const [action,phase] of [['rollback','backed-up'],['deploy','failed-after-activation'],['activate','pausing']]){
  await writeJson(path.join(runtime,'journal.json'),{action,phase,target:'original'});
  await assert.rejects(resumeActivation({runtime},'unused','different'),/manual recovery/);
 }
});
