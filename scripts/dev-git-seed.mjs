import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureProjectGitReadiness } from '../packages/core/src/git/git-repository.ts';
import { developmentGitTarget, isolatedGitInvocation } from './lib/dev-git-policy.mjs';

// FNXC:DevIsolation 2026-09-08-17:25: Provision only the owned synthetic repository, using canonical baseline plumbing with executable Git configuration disabled. This standalone launcher phase grants no write commands to the guarded application.
const base=process.env.FUSION_DEV_ISOLATED_DIR;
if (!base || process.env.FUSION_DEV_ISOLATED !== '1') throw new Error('Missing development ownership');
const identity=JSON.parse(await fs.readFile(path.join(base,'dev-isolation.json'),'utf8'));
const source=await fs.realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'));
const project=path.join(base,'project');
if (identity.kind !== 'fusion-development' || identity.source !== source || identity.token !== process.env.FUSION_DEV_TOKEN || process.env.HOME !== path.join(base,'home') || process.cwd() !== project || await fs.realpath(project) !== project) throw new Error('Development Git bootstrap ownership mismatch');
const execute=promisify(execFile);
const operations=new Set(['init','ls-files','rev-parse','symbolic-ref','hash-object','read-tree','update-index','write-tree','commit-tree','update-ref','for-each-ref','branch']);
await ensureProjectGitReadiness(project,{runner:async(command,args,options)=>{
  const target=developmentGitTarget(args,options);
  if(command !== 'git' || target.options?.cwd !== project || !operations.has(target.args[0])) throw new Error('Unexpected development Git bootstrap command');
  const safe=isolatedGitInvocation(args,options,base);
  const index=options?.env?.GIT_INDEX_FILE;
  if(index){
    if(!(await fs.realpath(path.dirname(index))).startsWith(path.join(base,'home')+path.sep)) throw new Error('Development bootstrap index escaped its profile');
    safe.options.env.GIT_INDEX_FILE=index;
  }
  for(const name of ['GIT_AUTHOR_NAME','GIT_AUTHOR_EMAIL','GIT_COMMITTER_NAME','GIT_COMMITTER_EMAIL']) if(options?.env?.[name]) safe.options.env[name]=options.env[name];
  if(target.args[0] === 'init') safe.args.push('--template=');
  return execute('git',['-c','commit.gpgsign=false',...safe.args],{...safe.options,encoding:'utf8',windowsHide:true});
}});
