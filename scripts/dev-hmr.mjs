#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import net from 'node:net';
import { resolveIsolatedDevPaths } from './dev-with-memory-lib.mjs';
import { devPort, prepareDevIsolation, verifyDevBackend } from './lib/dev-isolation.mjs';

// FNXC:DevIsolation 2026-09-07-14:11: Both halves of HMR share an owned profile. Never fall back to the production API.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dashboardDir = path.join(repoRoot, 'packages/dashboard');
const apiPort = devPort(process.env.FUSION_API_PORT);
const vitePort = devPort(process.env.FUSION_VITE_PORT, 5184);
if (apiPort === vitePort) throw new Error('Development API and UI need different ports.');
const paths = Object.fromEntries(Object.entries(resolveIsolatedDevPaths({
  repoRoot, home: process.env.HOME || process.env.USERPROFILE,
  explicitDir: process.env.FUSION_DEV_ISOLATED_DIR,
})).map(([key, value]) => [key, path.resolve(value)]));
for (const port of [apiPort, vitePort]) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', () => reject(new Error(`Development port ${port} is occupied. No existing process was stopped.`)));
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
}
const env = { ...await prepareDevIsolation(paths, repoRoot), FUSION_API_PORT: String(apiPort), FUSION_VITE_PORT: String(vitePort) };
const proof = { target: `http://127.0.0.1:${apiPort}`, token: env.FUSION_DEV_TOKEN };
const stopFile = path.join(paths.base, 'stop-request');
await fs.rm(stopFile, { force: true });
const children = [];
let stopping = false;
function launch(args, cwd, ipc = false) {
  // Standalone development supervisor: IPC permits graceful Windows shutdown of this runner's own child.
  const child = spawn(process.execPath, args, { cwd, env, windowsHide: true, stdio: ipc ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit' });
  children.push(child);
  child.on('error', error => { console.error(error.message); shutdown(1); });
  child.on('exit', code => { if (!stopping) shutdown(code ?? 1); });
  return child;
}
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  clearInterval(stopPoll);
  for (const child of children) {
    if (child.exitCode !== null) continue;
    if (child.connected) child.send({ type: 'fusion:dev-stop' });
    else child.kill();
  }
  process.exitCode = code;
}
const stopPoll = setInterval(async () => { if (await fs.stat(stopFile).catch(() => null)) shutdown(); }, 500);
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
console.log(`[dev-hmr] Isolated storage: ${paths.base}`);
launch([path.join(repoRoot, 'scripts/dev-with-memory.mjs'), `--isolated=${paths.base}`, '--watch', '--prebuild=none', 'dashboard', '--no-auth', '--port', String(apiPort)], repoRoot, true);
let ready = false;
for (let attempt = 0; attempt < 180 && !stopping; attempt++) {
  try {
    await verifyDevBackend(proof);
    const health = await fetch(`${proof.target}/api/health`, { signal: globalThis.AbortSignal.timeout(2000) });
    if (!health.ok || (await health.json()).status !== 'ok') throw new Error('API is still starting.');
    ready = true;
    break;
  } catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
}
if (!ready) { console.error('[dev-hmr] Isolated API did not become ready. UI was not started.'); shutdown(1); }
else {
  const require = createRequire(path.join(dashboardDir, 'package.json'));
  const vite = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js');
  launch([vite, '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], dashboardDir);
  console.log(`[dev-hmr] Open http://127.0.0.1:${vitePort} — development data only; automation disabled.`);
}
