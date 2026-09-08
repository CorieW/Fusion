import { developmentGitAllowed, parseDevelopmentGitShell } from './dev-git-policy.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

// FNXC:DevIsolation 2026-09-07-14:11: Development must own its profile, project and database. A different UI port alone must never grant access to production.
export function devPort(value, fallback = 4050) {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 4040) throw new Error('Development requires a non-production port in 1024..65535 (4040 is reserved).');
  return port;
}

export function isolatedDashboardArgs(args, env = {}) {
  if (!['dashboard', 'serve'].includes(args[0])) throw new Error('Development launchers run the isolated dashboard only.');
  const remaining = [];
  const ports = [];
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--port' || arg === '-p') {
      if (!args[i + 1]) throw new Error('Missing --port value.');
      ports.push(devPort(args[++i]));
    } else if (arg.startsWith('--port=')) ports.push(devPort(arg.slice(7)));
    else if (arg === '--host') {
      if (!args[i + 1]) throw new Error('Missing --host value.');
      i++;
    } else if (!arg.startsWith('--host=') && !['--engine', '--supervise', '--no-engine', '--no-supervise'].includes(arg)) remaining.push(arg);
  }
  if (ports.length > 1) throw new Error('Specify the development port only once.');
  return ['dashboard', ...remaining, '--host', '127.0.0.1', '--port', String(ports[0] ?? devPort(env.FUSION_API_PORT)), '--no-engine', '--no-supervise'];
}

export function isolatedEnvironment(env, paths, token) {
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) =>
    !/DATABASE|^PG|^FUSION_|API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|^HOME$|^USERPROFILE$|^APPDATA$|^LOCALAPPDATA$|^XDG_|^GIT_(DIR|WORK_TREE|COMMON_DIR|CONFIG|SSH)|^NODE_OPTIONS$|CODEX_HOME|CLAUDE_CONFIG|PI_CODING_AGENT_DIR|SSH_AUTH_SOCK|^GH_|^GITHUB_|^AWS_|^AZURE_|^GOOGLE_|^CLOUDSDK_|NPM_CONFIG_USERCONFIG/i.test(key)));
  return {
    ...clean, HOME: paths.home, USERPROFILE: paths.home,
    APPDATA: path.join(paths.home, 'AppData/Roaming'), LOCALAPPDATA: path.join(paths.home, 'AppData/Local'),
    XDG_CONFIG_HOME: path.join(paths.home, '.config'), XDG_DATA_HOME: path.join(paths.home, '.local/share'),
    XDG_CACHE_HOME: path.join(paths.home, '.cache'),
    TEMP: path.join(paths.home, 'tmp'), TMP: path.join(paths.home, 'tmp'), TMPDIR: path.join(paths.home, 'tmp'),
    FUSION_DEV_ISOLATED: '1', FUSION_DEV_ISOLATED_DIR: paths.base, FUSION_DEV_TOKEN: token,
    FUSION_SKIP_ONBOARDING: '1', FUSION_SKIP_STARTUP_UPDATE_PREFLIGHT: '1',
    FUSION_SKIP_DIST_FRESHNESS_CHECK: '1',
    FUSION_TEST_MODE: '1',
  };
}

export async function prepareDevIsolation(paths, repoRoot, env = process.env) {
  const base = path.resolve(paths.base);
  const source = await fs.realpath(repoRoot);
  const foldedBase = base.toLowerCase(), foldedSource = source.toLowerCase();
  if (foldedBase === foldedSource || foldedBase.startsWith(foldedSource + path.sep) || foldedSource.startsWith(foldedBase + path.sep)
    || foldedBase.split(path.sep).some(part => ['.fusion', '.git', 'node_modules'].includes(part))) {
    throw new Error('Development storage must be outside the checkout and production .fusion directories.');
  }
  await fs.mkdir(base, { recursive: true });
  if ((await fs.realpath(base)).toLowerCase() !== base.toLowerCase()) throw new Error('Development storage must not be redirected through a symlink or junction.');
  const marker = path.join(base, 'dev-isolation.json');
  let identity;
  try { identity = JSON.parse(await fs.readFile(marker, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if ((await fs.readdir(base)).length) throw new Error('Refusing to adopt a nonempty directory without a development ownership marker.');
    identity = { kind: 'fusion-development', source, token: randomBytes(32).toString('hex') };
    await fs.writeFile(marker, JSON.stringify(identity, null, 2), { flag: 'wx', mode: 0o600 });
  }
  if (identity.kind !== 'fusion-development' || identity.source !== source || !/^[a-f0-9]{64}$/.test(identity.token)) throw new Error('Development directory ownership mismatch.');
  for (const directory of [paths.home, paths.project, path.join(paths.home, '.fusion'), path.join(paths.home, 'tmp'), path.join(paths.home, 'AppData/Roaming'), path.join(paths.home, 'AppData/Local')]) {
    await fs.mkdir(directory, { recursive: true });
    if ((await fs.realpath(directory)).toLowerCase() !== path.resolve(directory).toLowerCase() || !path.resolve(directory).toLowerCase().startsWith(foldedBase + path.sep)) throw new Error('Development profile contains an unsafe redirected path.');
  }
  const settingsFile = path.join(paths.home, '.fusion/settings.json');
  const settingsStat = await fs.lstat(settingsFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (settingsStat?.isSymbolicLink()) throw new Error('Development settings must not be a symlink.');
  let settings = {};
  try { settings = JSON.parse(await fs.readFile(settingsFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  Object.assign(settings, {
    testMode: true, enginePaused: true, autoUpdateAndRestart: false, autoBackupEnabled: false,
    updateCheckEnabled: false, localNetworkDiscoveryEnabled: false, ntfyEnabled: false,
    webhookEnabled: false, settingsSyncEnabled: false, mcpServers: [], remoteAccess: { enabled: false },
    openrouterModelSync: false, orcarouterModelSync: false, opencodeGoModelSync: false,
    vitestAutoKillEnabled: false, fnBinaryCheckEnabled: false,
  });
  await fs.writeFile(settingsFile, JSON.stringify(settings, null, 2));
  return isolatedEnvironment(env, paths, identity.token);
}

export function devProxyConfiguration(env) {
  if (env.FUSION_DEV_ISOLATED !== '1' || !/^[a-f0-9]{64}$/.test(env.FUSION_DEV_TOKEN ?? '')) throw new Error('Start an isolated backend with pnpm dev:hmr. Standalone Vite cannot proxy to production.');
  return { target: `http://127.0.0.1:${devPort(env.FUSION_API_PORT)}`, token: env.FUSION_DEV_TOKEN };
}

export async function verifyDevBackend({ target, token }, fetcher = globalThis.fetch) {
  const response = await fetcher(`${target}/__fusion_dev_identity`, { signal: globalThis.AbortSignal.timeout(2000), redirect: 'error' });
  const identity = await response.json();
  if (!response.ok || identity.kind !== 'fusion-development' || identity.token !== token) throw new Error('API is not the expected isolated development backend.');
}

export function developmentRequestAllowed(method, pathname) {
  if (/^\/api\/providers(?:\/|$)/.test(pathname)) return false;
  if (/^\/api\/(?:terminal|shell|filesystem|system)(?:\/|$)/.test(pathname)) return false;
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return true;
  if (method === 'POST') return /^\/api\/(?:agents|workflows|tasks|events\/keepalive|diagnostics\/resume-events)$/.test(pathname);
  if (method === 'PATCH' || method === 'DELETE') return /^\/api\/(?:agents|workflows)\/[\w-]+$/.test(pathname);
  if (method === 'PUT') return /^\/api\/settings(?:\/global)?$/.test(pathname);
  return false;
}

export function developmentCommandAllowed(command, args, options, base, ownedPids = new Set()) {
  const executable = path.basename(String(command)).toLowerCase().replace(/\.exe$/, '');
  const inside = value => typeof value === 'string' && path.resolve(value).toLowerCase().startsWith(path.resolve(base).toLowerCase() + path.sep);
  if (['postgres', 'initdb', 'pg_ctl'].includes(executable)) {
    const index = args.indexOf('-D');
    const dataDir = index >= 0 ? args[index + 1] : args.find(arg => arg.startsWith('--pgdata='))?.slice(9);
    return inside(dataDir);
  }
  if (executable === 'taskkill') {
    const index = args.findIndex(arg => arg.toLowerCase() === '/pid');
    return index >= 0 && ownedPids.has(Number(args[index + 1])) && !args.some(arg => arg.toLowerCase() === '/im');
  }
  return executable === 'git' && !options?.shell && inside(options?.cwd ?? process.cwd()) && developmentGitAllowed(args);
}

export function developmentGitShellAllowed(command, options, base) {
  const args=parseDevelopmentGitShell(command);
  return !!args && developmentCommandAllowed('git',args,options,base);
}
