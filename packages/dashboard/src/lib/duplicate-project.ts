import { win32, posix } from 'node:path';
import { AgentStore, resolveEffectiveSettingValues, type TaskStore } from "@fusion/core";
import { duplicateAgentConfiguration } from "./duplicate-agent.js";

/** FNXC:Duplicate 2026-09-07-04:09: Rebind references recursively while preserving graph structure and custom configuration. */
export function remapConfiguration<T>(value: T, ids: Map<string, string>, sourceRoot: string, targetRoot: string): T {
  // FNXC:ProjectDuplicate 2026-09-08-12:40: Windows roots are case-insensitive and accept either separator. Compare normalized path boundaries, not string prefixes, while leaving prose and unrelated paths alone.
  const paths = process.platform === 'win32' || /^[a-z]:/i.test(sourceRoot) || sourceRoot.startsWith(String.fromCharCode(92,92)) ? win32 : posix;
  const visit = (item: unknown): unknown => {
    if (typeof item === "string") {
      if (ids.has(item)) return ids.get(item);
      if (paths.isAbsolute(item)) {
        const relative = paths.relative(sourceRoot, item);
        if (!relative) return targetRoot;
        if (relative !== '..' && !relative.startsWith('..' + paths.sep) && !paths.isAbsolute(relative)) return paths.join(targetRoot, relative);
      }
      return item;
    }
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, child]) => [ids.get(key) ?? key, visit(child)]));
    return item;
  };
  return visit(value) as T;
}

/** FNXC:Duplicate 2026-09-07-04:09: A project copy is a paused configuration template. Tasks, history, working files and autonomous schedules stay in the source project. */
export async function copyProjectConfiguration(source: TaskStore, target: TaskStore): Promise<void> {
  await target.updateSettings({ enginePaused: true });
  const sourceAgents = new AgentStore({ rootDir: source.getFusionDir(), asyncLayer: source.getAsyncLayer() ?? undefined });
  const targetAgents = new AgentStore({ rootDir: target.getFusionDir(), asyncLayer: target.getAsyncLayer() ?? undefined });
  await sourceAgents.init({ provisionDefaults: false });
  await targetAgents.init({ provisionDefaults: false });
  const agents = await sourceAgents.listAgents();
  const ids = new Map<string, string>();
  for (const agent of agents) {
    const copy = await duplicateAgentConfiguration({ ...agent, reportsTo: undefined }, sourceAgents, targetAgents, source.getRootDir(), target.getRootDir(), agent.name, true);
    ids.set(agent.id, copy.id);
  }
  const workflows = await source.listWorkflowDefinitions();
  for (const workflow of workflows) {
    const copy = await target.createWorkflowDefinition({ name: workflow.name, description: workflow.description, icon: workflow.icon, kind: workflow.kind,
      ir: remapConfiguration(workflow.ir, ids, source.getRootDir(), target.getRootDir()), layout: workflow.layout });
    ids.set(workflow.id, copy.id);
  }
  // FNXC:Duplicate 2026-09-07-04:09: A second pass also remaps cross-workflow references after every destination ID exists.
  for (const workflow of workflows) await target.updateWorkflowDefinition(ids.get(workflow.id)!, {
    ir: remapConfiguration(workflow.ir, ids, source.getRootDir(), target.getRootDir()),
  });
  for (const agent of agents) {
    const copy = (await targetAgents.getAgent(ids.get(agent.id)!))!;
    await targetAgents.updateAgent(copy.id, {
      reportsTo: agent.reportsTo ? ids.get(agent.reportsTo) : undefined,
      runtimeConfig: remapConfiguration(copy.runtimeConfig, ids, source.getRootDir(), target.getRootDir()),
      metadata: remapConfiguration(copy.metadata, ids, source.getRootDir(), target.getRootDir()),
    });
  }
  const sourceId = source.getAsyncLayer()?.projectId;
  const targetId = target.getAsyncLayer()?.projectId;
  if (sourceId && targetId) for (const workflow of workflows) {
    const storedValues = await source.getWorkflowSettingValuesAsync(workflow.id, sourceId);
    const values = resolveEffectiveSettingValues(workflow.ir.version === "v2" ? workflow.ir.settings ?? [] : [], storedValues);
    if (Object.keys(values).length) await target.updateWorkflowSettingValues(ids.get(workflow.id)!, targetId, remapConfiguration(values, ids, source.getRootDir(), target.getRootDir()));
    const overrides = await source.getWorkflowPromptOverridesAsync(workflow.id, sourceId);
    if (Object.keys(overrides).length) await target.updateWorkflowPromptOverrides(ids.get(workflow.id)!, targetId, overrides);
  }
  const { project } = await source.getSettingsByScope();
  const settings = remapConfiguration(project, ids, source.getRootDir(), target.getRootDir());
  await target.updateSettings({ ...settings, enginePaused: true });
}
