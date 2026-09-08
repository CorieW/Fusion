import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { devPort, isolatedDashboardArgs, isolatedEnvironment, prepareDevIsolation, devProxyConfiguration, verifyDevBackend, developmentRequestAllowed, developmentCommandAllowed } from '../lib/dev-isolation.mjs';
import { parseDevWrapperArgs, buildDevNodeArgs } from '../dev-with-memory-lib.mjs';
import { pathToFileURL, URL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('every wrapper invocation isolates even when inherited settings try to disable it', () => {
  for (const args of [[], ['dashboard'], ['serve'], ['--watch'], ['--isolated']]) {
    assert.equal(parseDevWrapperArgs(args, { FUSION_DEV_ISOLATED: '0' }).isolated, true);
  }
});
test('Windows and POSIX profiles, connections and credentials are separated', () => {
  const paths = { base: path.resolve('sandbox'), home: path.resolve('sandbox/home') };
  const env = isolatedEnvironment({ PATH: 'keep', HOME: 'live', USERPROFILE: 'live', APPDATA: 'live', LOCALAPPDATA: 'live', DATABASE_URL: 'live', FUSION_TEST_DATABASE_URL: 'live', PGHOST: 'live', PGPASSWORD: 'live', OPENAI_API_KEY: 'live', CODEX_HOME: 'live', GIT_WORK_TREE: 'live', NODE_OPTIONS: '--import malicious', FUSION_LOCAL_CONTROL: 'live', GITHUB_TOKEN: 'live', SSH_AUTH_SOCK: 'live' }, paths, 'a'.repeat(64));
  assert.equal(env.PATH, 'keep');
  assert.equal(env.HOME, paths.home);
  assert.equal(env.USERPROFILE, paths.home);
  assert.equal(env.FUSION_TEST_MODE, '1');
  assert.equal(Object.values(env).includes('live'), false);
  for (const key of ['APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']) assert.ok(env[key].startsWith(paths.home + path.sep));
});
test('all port spellings produce an explicit safe CLI port and force local UI-only mode', () => {
  for (const option of [['--port', '4051'], ['--port=4051'], ['-p', '4051']]) {
    const result = isolatedDashboardArgs(['serve', ...option, '--host=0.0.0.0', '--engine', '--supervise']);
    assert.deepEqual(result, ['dashboard', '--host', '127.0.0.1', '--port', '4051', '--no-engine', '--no-supervise']);
  }
  for (const option of [['--port', '4040'], ['--port=4040'], ['-p', '4040'], ['--port'], ['--port', '4051', '--port=4052']]) assert.throws(() => isolatedDashboardArgs(['dashboard', ...option]));
  assert.throws(() => isolatedDashboardArgs(['init', '--path', '/production']));
});
test('Vite has no production fallback, including explicit production ports', () => {
  for (const env of [{}, { FUSION_API_PORT: '4040' }, { FUSION_DEV_ISOLATED: '1', FUSION_DEV_TOKEN: 'bad' }, { FUSION_DEV_ISOLATED: '1', FUSION_DEV_TOKEN: 'a'.repeat(64), FUSION_API_PORT: '4040' }]) assert.throws(() => devProxyConfiguration(env));
  for (const port of [0, 4040, 'abc', -1, 65536]) assert.throws(() => devPort(port));
  assert.equal(devProxyConfiguration({ FUSION_DEV_ISOLATED: '1', FUSION_DEV_TOKEN: 'a'.repeat(64) }).target, 'http://127.0.0.1:4050');
});
test('an unrelated, failed or redirected backend never authorizes proxying', async () => {
  const proof = { target: 'http://127.0.0.1:4050', token: 'owned' };
  for (const identity of [{ status: 'ok' }, { kind: 'fusion-development', token: 'other' }]) await assert.rejects(verifyDevBackend(proof, async () => ({ ok: true, json: async () => identity })));
  await assert.rejects(verifyDevBackend(proof, async () => { throw new Error('offline'); }));
  await verifyDevBackend(proof, async (url, options) => {
    assert.equal(url, proof.target + '/__fusion_dev_identity');
    assert.equal(options.redirect, 'error');
    return { ok: true, json: async () => ({ kind: 'fusion-development', token: 'owned' }) };
  });
});
test('paths with spaces work and storage cannot adopt checkout or unowned data', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fusion-dev-isolation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source checkout');
  await fs.mkdir(source);
  const pathsFor = base => ({ base, home: path.join(base, 'home'), project: path.join(base, 'project') });
  const paths = pathsFor(path.join(root, 'development data'));
  const first = await prepareDevIsolation(paths, source, {});
  const second = await prepareDevIsolation(paths, source, { DATABASE_URL: 'production' });
  assert.equal(first.FUSION_DEV_TOKEN, second.FUSION_DEV_TOKEN);
  assert.equal(second.DATABASE_URL, undefined);
  const settings = JSON.parse(await fs.readFile(path.join(paths.home, '.fusion/settings.json')));
  assert.equal(settings.testMode, true);
  assert.equal(settings.vitestAutoKillEnabled, false);
  assert.equal(settings.autoUpdateAndRestart, false);
  await assert.rejects(prepareDevIsolation(pathsFor(source), source));
  await assert.rejects(prepareDevIsolation(pathsFor(path.join(source, 'nested')), source));
  const unowned = path.join(root, 'unowned');
  await fs.mkdir(unowned);
  await fs.writeFile(path.join(unowned, 'keep'), 'production data');
  await assert.rejects(prepareDevIsolation(pathsFor(unowned), source));
  assert.equal(await fs.readFile(path.join(unowned, 'keep'), 'utf8'), 'production data');
  const loader = path.join(source, 'loader.mjs');
  assert.ok(buildDevNodeArgs({ preload: loader, loader, entry: loader }).includes(pathToFileURL(loader).href));
});
test('preview editing permits definitions but refuses execution and real-project registration', () => {
  assert.equal(developmentRequestAllowed('GET', '/api/providers/cursor-cli/status'), false);
  assert.equal(developmentRequestAllowed('POST', '/api/events/keepalive'), true);
  assert.equal(developmentRequestAllowed('POST', '/api/diagnostics/resume-events'), true);
  for (const [method, route] of [['POST', '/api/projects'], ['POST', '/api/projects/id/duplicate'], ['POST', '/api/system/restart'], ['POST', '/api/workflows/design'], ['POST', '/api/agents/id/runs'], ['POST', '/api/tasks/id/execute'], ['GET', '/api/terminal'], ['POST', '/api/agents/import']]) assert.equal(developmentRequestAllowed(method, route), false, `${method} ${route}`);
  for (const [method, route] of [['GET', '/api/projects'], ['POST', '/api/workflows'], ['POST', '/api/agents'], ['PATCH', '/api/workflows/id'], ['PUT', '/api/settings/global']]) assert.equal(developmentRequestAllowed(method, route), true, `${method} ${route}`);
});
test('provider/editor status probes cannot launch executables; only owned database and git processes are allowed', () => {
  const base = path.resolve('sandbox');
  for (const binary of ['cursor', 'Cursor.exe', 'cursor-agent', 'codex', 'claude', 'powershell', 'cmd.exe']) assert.equal(developmentCommandAllowed(binary, ['status', '--format', 'json'], { cwd: path.join(base, 'project') }, base), false);
  assert.equal(developmentCommandAllowed('postgres.exe', ['-D', path.join(base, 'home/cluster')], {}, base), true);
  assert.equal(developmentCommandAllowed('postgres.exe', ['-D', path.resolve('production')], {}, base), false);
  assert.equal(developmentCommandAllowed('git', ['status'], { cwd: path.join(base, 'project') }, base), true);
  assert.equal(developmentCommandAllowed('git', ['status'], { cwd: path.resolve('production') }, base), false);
  assert.equal(developmentCommandAllowed('taskkill', ['/pid', '123'], {}, base, new Set([123])), true);
  assert.equal(developmentCommandAllowed('taskkill', ['/pid', '456'], {}, base, new Set([123])), false);
});
test('the actual preload blocks child execution and production connections before dispatch', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fusion-dev-guard-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await fs.mkdir(source);
  const base = path.join(root, 'sandbox');
  const env = await prepareDevIsolation({ base, home: path.join(base, 'home'), project: path.join(base, 'project') }, source, process.env);
  const guard = new URL('../lib/dev-runtime-guard.mjs', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import cp from 'node:child_process';
    import net from 'node:net';
    import tls from 'node:tls';
    import http from 'node:http';
    import {promisify} from 'node:util';
    let dispatched = false;
    net.Socket.prototype.connect = () => { dispatched = true; };
    await import(${JSON.stringify(guard)});
    assert.throws(() => cp.execFileSync(process.execPath, ['-e', 'process.exit(0)']), /disabled/);
    await assert.rejects(promisify(cp.execFile)(process.execPath, ['-e', 'process.exit(0)']), /disabled/);
    assert.equal(cp.spawnSync(process.execPath, ['-e', 'process.exit(0)']).status, 1);
    assert.throws(() => new net.Socket().connect(4040, '127.0.0.1'), /isolation/);
    assert.equal(dispatched, false);
    assert.throws(() => tls.connect(443, 'example.invalid'), /blocks/);
    let status;
    const server = new http.Server();
    server.on('request', () => { dispatched = true; });
    server.emit('request', {url:'/api/providers/cursor-cli/status',method:'GET'}, {writeHead(code){status=code},end(){}});
    assert.equal(status,403);
    assert.equal(dispatched,false);
    console.log('guard passed');
  `;
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { env, windowsHide: true });
  assert.equal(result.stdout.trim(), 'guard passed');
});

test('Git aliases, external diff, repository redirects and network commands are refused',()=>{
 const base=path.resolve('sandbox'),opts={cwd:path.join(base,'project')};
 for(const args of [['-c','alias.escape=!node --version','escape'],['fetch'],['clone','remote'],['diff','--ext-diff'],['log','--show-signature'],['log','--format=%G?'],['--git-dir=/outside','status'],['status','--output=/outside'],['submodule','update']]) assert.equal(developmentCommandAllowed('git',args,opts,base),false,args.join(' '));
 for(const args of [['status','--porcelain'],['rev-parse','--show-toplevel'],['log','--oneline','-5'],['diff','--stat']]) assert.equal(developmentCommandAllowed('git',args,opts,base),true);
});
test('actual guard stops Git alias subprocesses and neutralizes local fsmonitor',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'fusion-dev-git-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const source=path.join(root,'source');await fs.mkdir(source);
 const base=path.join(root,'sandbox'),project=path.join(base,'project');
 const env=await prepareDevIsolation({base,home:path.join(base,'home'),project},source,process.env);
 await promisify(execFile)('git',['init'],{cwd:project,env});
 const sentinel=path.join(base,'escaped');const hook=path.join(base,'hook.cjs');
 await fs.writeFile(hook,`require('fs').writeFileSync(${JSON.stringify(sentinel)},'bad')`);
 await promisify(execFile)('git',['config','core.fsmonitor',`node "${hook.split(path.sep).join('/')}"`],{cwd:project,env});
 const guard=new URL('../lib/dev-runtime-guard.mjs',import.meta.url).href;
 const script=`import cp from 'node:child_process';import assert from 'node:assert/strict';import fs from 'node:fs';
 assert.throws(()=>cp.execFileSync('git',['-c','alias.escape=!node --version','escape']),/disabled/);
 cp.execFileSync('git',['status','--porcelain']); cp.execSync('git status --porcelain');
 assert.equal(fs.existsSync(${JSON.stringify(sentinel)}),false);console.log('isolated');`;
 const result=await promisify(execFile)(process.execPath,['--import',guard,'--input-type=module','-e',script],{cwd:project,env});assert.equal(result.stdout.trim(),'isolated');
});
