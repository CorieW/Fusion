import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
/* global AbortSignal */

// FNXC:LocalDeployment 2026-09-06-20:51: Standalone operator tooling owns bounded, attached children; no production process is selected by port.
// process-supervisor-allowlist: standalone Windows deployment tool outside the workspace dependency graph; attached children have bounded lifetimes.
export const here = path.dirname(fileURLToPath(import.meta.url));
export const sourceRoot = path.resolve(here, '../..');
export const timestamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
export const exists = async p => fs.access(p).then(() => true, () => false);
export const readJson = async p => JSON.parse(await fs.readFile(p, 'utf8'));
export async function writeJson(p, value) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const temp = `${p}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  await fs.rename(temp, p);
}
export function contained(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`Unsafe path outside ${root}: ${target}`);
  return path.resolve(target);
}
export async function hashFile(p) {
  const hash = createHash('sha256');
  if ((await fs.stat(p)).size <= 8 * 1024 ** 2) return hash.update(await fs.readFile(p)).digest('hex');
  for await (const chunk of createReadStream(p)) hash.update(chunk);
  return hash.digest('hex');
}
export async function files(root, prefix = '') {
  const result = [];
  const directories = [prefix];
  while (directories.length) {
    const current = directories.pop();
    for (const item of await fs.readdir(path.join(root, current), { withFileTypes: true })) {
      const rel = path.join(current, item.name);
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) directories.push(rel);
      else if (item.isFile()) result.push(rel);
    }
  }
  return result.sort();
}
async function boundedMap(items, fn) {
  const results = new Array(items.length);
  let next = 0, failure;
  await Promise.all(Array.from({length:Math.min(32,items.length)},async()=>{
    while(next<items.length&&!failure) {
      const index=next++;
      try {results[index]=await fn(items[index]);}catch(error){failure=error;}
    }
  }));
  if(failure)throw failure;
  return results;
}
export async function checksums(root, selected = null) {
  const paths = selected ?? await files(root);
  const hashes = await boundedMap(paths,rel=>hashFile(path.join(root,rel)));
  return Object.fromEntries(paths.map((rel,index)=>[rel,hashes[index]]));
}
export async function verifyChecksums(root, hashes) {
  await boundedMap(Object.entries(hashes),async([rel,expected])=>{
    const file = contained(root, path.join(root, rel));
    if (await hashFile(file) !== expected) throw new Error(`Checksum mismatch: ${file}`);
  });
}
export async function run(exe, args, { cwd, env = process.env, input, log, timeout = 30 * 60_000, codes = [0] } = {}) {
  const output = log ? await fs.open(log, 'a') : null;
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(exe, args, { cwd, env, windowsHide: true, stdio: ['pipe', output?.fd ?? 'pipe', output?.fd ?? 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout?.on('data', b => { stdout += b; });
      child.stderr?.on('data', b => { stderr += b; });
      const timer = setTimeout(() => { child.kill(); reject(new Error(`Timed out: ${path.basename(exe)}; see ${log ?? 'command output'}`)); }, timeout);
      child.on('error', e => { clearTimeout(timer); reject(e); });
      const detachedServer = path.basename(exe).toLowerCase() === 'pg_ctl.exe';
      child.on(detachedServer ? 'exit' : 'close', code => {
        clearTimeout(timer);
        // FNXC:LocalDeployment 2026-09-06-21:19: pg_ctl can leave inherited pipe handles in its Windows server after the launcher exits; those handles must not block the deployment driver.
        if (detachedServer) { child.stdout?.destroy(); child.stderr?.destroy(); }
        if (!codes.includes(code)) reject(new Error(`${path.basename(exe)} exited ${code}: ${log ?? stderr.slice(-1800)}`));
        else resolve(stdout.trim());
      });
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
  } finally { await output?.close(); }
}
export const ps = (action, args = []) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'windows.ps1'), '-Action', action, ...args]);
export async function copyTree(from, to, excludes = []) {
  await fs.mkdir(to, { recursive: true });
  await run('robocopy.exe', [from, to, '/E', '/MT:16', '/COPY:DAT', '/DCOPY:DAT', '/R:1', '/W:1', '/XJ', '/SL', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', ...(excludes.length ? ['/XD', ...excludes] : [])], { codes: [0,1,2,3,4,5,6,7] });
}
// FNXC:LocalDeployment 2026-09-08-12:44: Git Bash may put GNU tar first in PATH; use Windows tar explicitly so drive-qualified archive paths remain local filenames.
export function archiveExecutable(platform = process.platform, env = process.env) {
  return platform === 'win32' ? path.win32.join(env.SystemRoot ?? env.WINDIR ?? 'C:/Windows','System32','tar.exe') : 'tar';
}
export async function archiveTree(from, archive) {
  await fs.mkdir(path.dirname(archive),{recursive:true});
  await run(archiveExecutable(),['-cf',archive,'-C',from,'.']);
}
export async function restoreSnapshot(copy, backup, target, stateOnly=false) {
  if(copy.archive) {
    await fs.mkdir(target,{recursive:true});
    await run(archiveExecutable(),['-xf',contained(backup,path.join(backup,copy.archive)),'-C',target,...(stateOnly?['./.fusion']:[])]);
  } else {
    await copyTree(contained(backup,path.join(backup,copy.destination,stateOnly?'.fusion':'')),stateOnly?path.join(target,'.fusion'):target);
  }
}
export async function api(url, route, { method = 'GET', body, project } = {}) {
  const scopedRoute = project ? `${route}${route.includes('?') ? '&' : '?'}projectId=${encodeURIComponent(project)}` : route;
  const res = await fetch(`${url}/api${scopedRoute}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${method} ${route}: HTTP ${res.status}: ${(await res.text()).slice(0,300)}`);
  return res.json();
}
export async function waitUntil(check, description, timeout = 180_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for ${description}`);
}
export function isSourceFile(rel) {
  return !/(^|[/\\])(\.git|\.fusion|\.env(?:\..*)?|node_modules|dist|coverage|\.worktrees)([/\\]|$)/i.test(rel)
    && !/\.(pem|key|pfx|p12|kdbx)$/i.test(rel);
}
export async function acquireLock(root) {
  await fs.mkdir(root, { recursive: true });
  const file = path.join(root, 'operation.lock');
  const handle = await fs.open(file, 'wx').catch(() => { throw new Error(`Another operation, or an interrupted operation, owns ${file}. Inspect Status and the journal before removing a stale lock.`); });
  await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  return async () => { await handle.close(); await fs.unlink(file); };
}
