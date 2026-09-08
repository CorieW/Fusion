import { isolatedGitInvocation, parseDevelopmentGitShell } from './dev-git-policy.mjs';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import childProcess from 'node:child_process';
import { promisify } from 'node:util';
import { syncBuiltinESMExports } from 'node:module';
import { developmentRequestAllowed, developmentCommandAllowed, developmentGitShellAllowed } from './dev-isolation.mjs';

// FNXC:DevIsolation 2026-09-07-14:11: Identify the isolated API to Vite and prohibit network calls to production, providers and integrations from the preview backend.
const base = process.env.FUSION_DEV_ISOLATED_DIR;
const token = process.env.FUSION_DEV_TOKEN;
if (!base || !token || process.env.HOME !== path.join(base, 'home') || process.env.USERPROFILE !== path.join(base, 'home')) throw new Error('Missing isolated development profile.');
const marker = JSON.parse(fs.readFileSync(path.join(base, 'dev-isolation.json'), 'utf8'));
if (marker.token !== token) throw new Error('Development identity mismatch.');
process.on('message', message => { if (message?.type === 'fusion:dev-stop') process.emit('SIGTERM'); });
process.on('disconnect', () => process.emit('SIGTERM'));
const originalEmit = http.Server.prototype.emit;
http.Server.prototype.emit = function (event, ...args) {
  if (event === 'upgrade' && !/^\/api\/ws(?:\?|$)/.test(args[0]?.url ?? '')) {
    args[1].destroy();
    return true;
  }
  if (event === 'request') {
    const request = args[0];
    const pathname = new globalThis.URL(request.url, 'http://localhost').pathname;
    // Preview definitions and appearance can be edited. Execution, project registration,
    // terminals, imports, filesystem operations and deployment controls remain unavailable.
    if (!developmentRequestAllowed(request.method, pathname)) {
      args[1].writeHead(403, { 'content-type': 'application/json' });
      args[1].end(JSON.stringify({ error: 'This operation is disabled in the isolated development preview.' }));
      return true;
    }
  }
  if (event === 'request' && args[0]?.url === '/__fusion_dev_identity') {
    args[1].writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    args[1].end(JSON.stringify({ kind: 'fusion-development', token }));
    return true;
  }
  return originalEmit.call(this, event, ...args);
};
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof first === 'object' ? first?.host : typeof args[1] === 'string' ? args[1] : 'localhost';
  const port = Number(typeof first === 'object' ? first?.port : first);
  let databasePort;
  try {
    const cluster = path.join(base, 'home/.fusion/embedded-postgres/test');
    const pid = fs.readFileSync(path.join(cluster, 'postmaster.pid'), 'utf8').split(/\r?\n/);
    if (path.resolve(pid[1]).toLowerCase() === path.resolve(cluster).toLowerCase()) databasePort = Number(pid[3]);
  } catch { /* No owned database is running yet. */ }
  if (!['localhost', '127.0.0.1', '::1'].includes(host ?? 'localhost') || port === 4040 || port !== databasePort) throw new Error('Development network isolation permits only its own PostgreSQL server.');
  return originalConnect.apply(this, args);
};
tls.connect = () => { throw new Error('Development preview blocks outbound TLS integrations.'); };
const ownedPids = new Set();
const originalExecFile = childProcess.execFile;
const originalExecFileSync = childProcess.execFileSync;
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
  const original = childProcess[name];
  childProcess[name] = (command, ...args) => {
    const argv = Array.isArray(args[0]) ? args[0] : [];
    const options = args.find(value => value && typeof value === 'object' && !Array.isArray(value));
    const allowed = ['exec', 'execSync'].includes(name)
      ? developmentGitShellAllowed(command, options, base)
      : name !== 'fork' && developmentCommandAllowed(command, argv, options, base, ownedPids);
    if (allowed) {
      const shellCall = ['exec','execSync'].includes(name);
      const gitArgs = shellCall ? parseDevelopmentGitShell(command) : argv;
      let result;
      if (shellCall || /^git(?:\.exe)?$/i.test(path.basename(command))) {
        const safe=isolatedGitInvocation(gitArgs,options,base);
        const callback=args.findLast(value=>typeof value==='function');
        if (shellCall) result=name==='execSync' ? originalExecFileSync('git',safe.args,safe.options) : originalExecFile('git',safe.args,safe.options,callback);
        else result=original(command,safe.args,safe.options,...(callback?[callback]:[]));
      } else result = original(command, ...args);
      if (result?.pid && /postgres(?:\.exe)?$/i.test(command)) ownedPids.add(result.pid);
      return result;
    }
    const error = Object.assign(new Error('External command execution is disabled in the development preview.'), { code: 'ENOENT' });
    if (name === 'spawnSync') {
      const empty = options?.encoding ? '' : Buffer.alloc(0);
      return { pid: 0, status: 1, signal: null, error, stdout: empty, stderr: empty, output: [null, empty, empty] };
    }
    const callback = args.findLast(value => typeof value === 'function');
    if (callback) { globalThis.queueMicrotask(() => callback(error, '', '')); return undefined; }
    throw error;
  };
  if (name === 'exec' || name === 'execFile') {
    childProcess[name][promisify.custom] = (...args) => {
      let child;
      const result = new Promise((resolve, reject) => {
        child = childProcess[name](...args, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
      });
      result.child = child;
      return result;
    };
  }
}
syncBuiltinESMExports();
