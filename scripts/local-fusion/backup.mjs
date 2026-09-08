import { isDeepStrictEqual } from 'node:util';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { api, checksums, copyTree, exists, ps, readJson, run, timestamp, verifyChecksums, writeJson } from './common.mjs';

// FNXC:LocalDeployment 2026-09-06-20:51: Logical dumps cover every database and role; a cold global snapshot and working-tree copies provide a matching rollback point.
const ident = name => '"' + name.replaceAll('"', '""') + '"';
const literal = value => "'" + value.replaceAll("'", "''") + "'";
export async function connection(config) {
  const lines = (await fs.readFile(path.join(config.dataHome, 'embedded-postgres/default/postmaster.pid'), 'utf8')).split(/\r?\n/);
  return { port: Number(lines[3]), database: 'fusion' };
}
export async function sql(config, text, conn = null) {
  conn ??= await connection(config);
  return run(path.join(config.pgTools, 'psql.exe'), ['-X', '-h', '127.0.0.1', '-p', String(conn.port), '-U', 'postgres', '-d', conn.database, '-At', '-v', 'ON_ERROR_STOP=1'], {
    env: { ...process.env, PGPASSWORD: config.pgPassword ?? 'password' }, input: text, timeout: 60_000,
  });
}
export async function jsonSql(config, query, conn) {
  const value = await sql(config, `SELECT COALESCE(json_agg(row_to_json(q)), '[]'::json) FROM (${query}) q;`, conn);
  return JSON.parse(value || '[]');
}
// FNXC:LocalDeployment 2026-09-08-12:30: Refuse upgrades before downtime when saved workflow references have no private definition snapshot. Never invent a replacement graph.
export async function assertWorkflowReferences(config, conn, read = jsonSql) {
  const missing = await read(config, `SELECT s.project_id,s.task_id,s.workflow_id FROM project.task_workflow_selection s LEFT JOIN project.workflows w ON w.project_id=s.project_id AND w.id=s.workflow_id WHERE w.id IS NULL ORDER BY s.project_id,s.task_id`, conn);
  if (missing.length) throw new Error(`Missing historical workflow snapshots (${missing.length} saved references): ${missing.slice(0,5).map(row => `${row.project_id}/${row.workflow_id}`).join(', ')}. Restore these private definitions from the previous release before activation; keep saved task selections intact.`);
}
export async function inventory(config, conn) {
  const tables = await jsonSql(config, "SELECT table_schema,table_name FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1,2", conn);
  const counts = {};
  for (const t of tables) counts[`${t.table_schema}.${t.table_name}`] = Number(await sql(config, `SELECT count(*) FROM ${ident(t.table_schema)}.${ident(t.table_name)};`, conn));
  const projects = await jsonSql(config, 'SELECT * FROM central.projects ORDER BY id', conn);
  const definitions = {};
  for (const table of ['agents', 'workflows', 'workflow_steps']) {
    definitions[table] = await jsonSql(config, `SELECT * FROM project.${table} ORDER BY project_id,id`, conn);
  }
  const settings = await jsonSql(config, 'SELECT project_id,settings FROM project.config ORDER BY project_id', conn);
  const migrations = await jsonSql(config, 'SELECT * FROM public.fusion_schema_migrations', conn);
  return { capturedAt: new Date().toISOString(), projects, counts, definitions, settings, migrations };
}
export function compareInventory(before, after, { rehearsal = false } = {}) {
  const failures = [];
  // FNXC:LocalDeployment 2026-09-08-12:54: Acceptance owns operator settings, not just row counts. Rehearsal may only enable its explicit pause/test overrides; production permits no silent setting loss.
  if (!Array.isArray(before.settings) || !Array.isArray(after.settings)) throw new Error('Settings inventory is missing; recapture before activation');
  for (const row of before.settings) {
    const next = after.settings.find(candidate => candidate.project_id === row.project_id);
    const expected = rehearsal ? { ...row.settings, enginePaused: true, testMode: true } : row.settings;
    if (!next || !isDeepStrictEqual(expected, next.settings)) failures.push(`Changed project settings: ${row.project_id}`);
  }
  for (const project of before.projects) {
    if (!after.projects.some(p => p.id === project.id && p.name === project.name)) failures.push(`Missing project ${project.id}`);
  }
  const durable = /\.(tasks|archived_tasks|agents|agent_runs|task_documents|task_document_revisions|chat_messages|chat_sessions|chat_room_messages|messages|secrets|secrets_global|agent_config_revisions|configuration_revisions|artifacts|goals|automations|activity_log|agent_activity_events|run_audit_events|usage_events|chat_token_usage|workflow_work_items|workflow_run_step_instances|task_workflow_selection|memory[^.]*|project_insight_run[^.]*)$/;
  for (const [table, count] of Object.entries(before.counts)) {
    if (durable.test(table) && (after.counts[table] ?? -1) < count) failures.push(`${table}: ${count} -> ${after.counts[table] ?? 'missing'}`);
  }
  for (const table of ['agents', 'workflows', 'workflow_steps']) {
    for (const row of before.definitions[table]) {
      const next = after.definitions[table].find(r => r.id === row.id && r.project_id === row.project_id);
      if (!next) { failures.push(`Missing ${table}: ${row.project_id}/${row.id}`); continue; }
      if (row.name !== next.name) failures.push(`Renamed ${table}: ${row.id}`);
      // Built-in workflows can legitimately change during the upgrade. Custom definitions must remain byte-for-byte equivalent in their authored fields.
      const fields = table === 'workflows' && !row.id.startsWith('builtin-') ? ['ir','layout','description'] : table === 'workflow_steps' && !row.template_id ? ['prompt','description','script_name','model_provider','model_id'] : [];
      for (const field of fields) if (JSON.stringify(row[field]) !== JSON.stringify(next[field])) failures.push(`Changed ${table}/${row.id}/${field}`);
      if (table === 'agents') {
        for (const field of ['instructionsText','runtimeConfig','soul','role','roles','permissionPolicy','bundleConfig']) {
          if (JSON.stringify(row.data?.[field]) !== JSON.stringify(next.data?.[field])) failures.push(`Changed agent ${row.id}/${field}`);
        }
      }
    }
  }
  if (failures.length) throw new Error(`Data verification failed: ${failures.join('; ')}`);
  return { checkedAt: new Date().toISOString(), projectCount: before.projects.length, durableTables: Object.keys(before.counts).filter(t => durable.test(t)).length, failures };
}
export async function assertIdle(config) {
  const projects = await api(config.url, '/projects');
  for (const project of projects) {
    const stats = await api(config.url, '/system-stats', { project: project.id });
    if (!stats.taskStats || stats.taskStats.active !== 0 || stats.taskStats.agents.running !== 0) throw new Error(`Activation pending: ${project.name} has active work. Nothing was stopped; retry after it finishes.`);
  }
  const running = await sql(config, "SELECT (SELECT count(*) FROM project.agent_runs WHERE status IN ('running','pending','starting')) + (SELECT count(*) FROM project.ai_sessions WHERE status IN ('running','streaming','processing')); ");
  if (Number(running) !== 0) throw new Error('Activation pending: live sessions remain. Nothing was stopped.');
  return projects;
}
export async function pauseProjects(config, projects) {
  await assertIdle(config);
  for (const project of projects) if (project.status === 'active') await api(config.url, `/projects/${project.id}/pause`, { method: 'POST', body: {} });
}
export async function resumeProjects(config, projects, pauseSettings = []) {
  for (const saved of pauseSettings) await api(config.url, '/settings', { method: 'PUT', project: saved.id, body: { enginePaused: saved.enginePaused } });
  for (const project of projects) if (project.status === 'active') await api(config.url, `/projects/${project.id}/resume`, { method: 'POST', body: {} });
}
export async function createBackup(config, { cold = false, stop, resume, release = null, projects = null, pauseSettings = [], onCreated } = {}) {
  await fs.mkdir(config.backups, { recursive: true });
  const free = await fs.statfs(config.backups);
  if (free.bavail * free.bsize < 10 * 1024 ** 3) throw new Error('Less than 10 GiB free in the backup destination; activation is blocked');
  const folder = path.join(config.backups, `Fusion-Full-${timestamp()}`);
  await fs.mkdir(folder, { recursive: false });
  await ps('Protect', ['-TargetPath', folder]);
  await onCreated?.(folder);
  console.log(`Backing up to ${folder}`);
  const conn = await connection(config);
  const baseline = await inventory(config, conn);
  await writeJson(path.join(folder, 'inventory.json'), baseline);
  await ps('Export', ['-OutputPath', path.join(folder, 'startup-task.xml')]);
  await fs.copyFile(config.legacyLauncher, path.join(folder, 'legacy-launcher.ps1'));
  if (await exists(path.join(config.runtime, 'active.json'))) await fs.copyFile(path.join(config.runtime, 'active.json'), path.join(folder, 'active.json'));
  const pgEnv = { ...process.env, PGPASSWORD: config.pgPassword ?? 'password' };
  await run(path.join(config.pgTools, 'pg_dumpall.exe'), ['-h','127.0.0.1','-p',String(conn.port),'-U','postgres','--globals-only','-f',path.join(folder,'roles.sql')], { env: pgEnv });
  const databases = await jsonSql(config, 'SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname', conn);
  for (let i = 0; i < databases.length; i++) {
    databases[i].file = `database-${i}.dump`;
    await run(path.join(config.pgTools,'pg_dump.exe'), ['-h','127.0.0.1','-p',String(conn.port),'-U','postgres','-d',databases[i].datname,'-Fc','-f',path.join(folder,databases[i].file)], { env: pgEnv });
    await run(path.join(config.pgTools,'pg_restore.exe'), ['--list',path.join(folder,databases[i].file)]);
  }
  let stopped = false;
  try {
    if (cold) { await stop(); stopped = true; }
    const copies = [{ source: config.dataHome, destination: 'global', kind: 'global' }];
    for (const project of baseline.projects) {
      copies.push({ source: project.path, destination: `projects/${project.id}`, kind: 'project' });
      const worktrees = await run('git.exe', ['-C', project.path, 'worktree', 'list', '--porcelain']);
      await fs.writeFile(path.join(folder, `${project.id}-worktrees.txt`), worktrees);
      for (const match of worktrees.matchAll(/^worktree (.+)$/gm)) {
        const root = path.resolve(match[1].trim());
        if (root.toLowerCase() !== path.resolve(project.path).toLowerCase() && !copies.some(c => path.resolve(c.source).toLowerCase() === root.toLowerCase())) copies.push({ source: root, destination: `worktrees/${copies.length}`, kind: 'worktree' });
      }
    }
    for (const copy of copies) {
      console.log(`Copying ${copy.source}`);
      // FNXC:LocalDeployment 2026-09-07-00:26: Windows tar follows dependency junctions and repeatedly archives their targets. Use the same bounded robocopy snapshot for every root; existing tar backups remain readable.
      await copyTree(copy.source, path.join(folder, copy.destination), copy.kind==='global' && !cold ? ['embedded-postgres'] : []);
    }
    const manifest = { format: 2, createdAt: new Date().toISOString(), cold, release, databases, copies, resumeProjects: projects ?? baseline.projects, pauseSettings, baseline: 'inventory.json' };
    await writeJson(path.join(folder, 'backup.json'), manifest);
    console.log('Hashing the full backup; large workspaces can take several minutes.');
    const hashes = await checksums(folder);
    await writeJson(path.join(folder,'checksums.json'), hashes);
    console.log(`Verifying ${Object.keys(hashes).length} backup files.`);
    await verifyChecksums(folder, hashes);
    await writeJson(path.join(folder,'verified.json'), { verifiedAt: new Date().toISOString(), files: Object.keys(hashes).length });
    return folder;
  } finally { if (stopped && resume) await resume(); }
}
export async function verifyBackup(folder) {
  if (!await exists(path.join(folder,'verified.json'))) throw new Error('Backup is incomplete or was never verified');
  console.log(`Rechecking backup integrity: ${folder}`);
  await verifyChecksums(folder, await readJson(path.join(folder,'checksums.json')));
  return readJson(path.join(folder,'backup.json'));
}
export { literal };
