// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import { copyProjectConfiguration, remapConfiguration } from "../duplicate-project.js";
const agents = vi.hoisted(() => ({ listAgents: vi.fn(async () => []), init: vi.fn(async () => {}) }));
vi.mock("@fusion/core", async () => ({ ...await vi.importActual<typeof import("@fusion/core")>("@fusion/core"), AgentStore: class { init = agents.init; listAgents = agents.listAgents; } }));
it("remaps agent/workflow relationships, keyed settings and rooted paths without changing source data", () => {
  const source = { columns: [{ agentId: "agent-old" }], workflowId: "WF-old", overrides: { "WF-old": { folder: "A:\\Old Project\\files" } }, prompt: "Keep agent-old in prose" };
  const copy = remapConfiguration(source, new Map([["agent-old", "agent-new"], ["WF-old", "WF-new"]]), "A:\\Old Project", "A:\\New Project");
  expect(copy).toEqual({ columns: [{ agentId: "agent-new" }], workflowId: "WF-new", overrides: { "WF-new": { folder: "A:\\New Project\\files" } }, prompt: "Keep agent-old in prose" });
  expect(source.columns[0].agentId).toBe("agent-old");
});
describe("project configuration duplication", () => {
  it.each([false, true])("copies a project with workflows=%s and never reads tasks/history", async populated => {
    const workflow = { id: "WF-old", name: "Process", description: "Custom", ir: { version: "v2", nodes: [], edges: [], columns: [], settings: [{ id: "strict", name: "Strict", type: "boolean", default: false }] }, layout: {} };
    const source = { getFusionDir: () => "/source/.fusion", getRootDir: () => "/source", getAsyncLayer: () => ({ projectId: "source" }), getWorkflowSettingValuesAsync: async () => ({ strict: true }), getWorkflowPromptOverridesAsync: async () => ({ step: "Custom prompt" }), listWorkflowDefinitions: vi.fn(async () => populated ? [workflow] : []), getSettingsByScope: async () => ({ project: { defaultWorkflowId: populated ? "WF-old" : "", maxConcurrent: 3, enginePaused: false } }), listTasks: vi.fn() };
    const target = { getFusionDir: () => "/target/.fusion", getRootDir: () => "/target", getAsyncLayer: () => ({ projectId: "target" }), updateWorkflowSettingValues: vi.fn(async () => {}), updateWorkflowPromptOverrides: vi.fn(async () => {}), updateSettings: vi.fn(async () => {}), createWorkflowDefinition: vi.fn(async () => ({ id: "WF-new" })), updateWorkflowDefinition: vi.fn(async () => {}) };
    await copyProjectConfiguration(source as unknown as TaskStore, target as unknown as TaskStore);
    expect(target.updateSettings).toHaveBeenLastCalledWith({ defaultWorkflowId: populated ? "WF-new" : "", maxConcurrent: 3, enginePaused: true });
    if (populated) {
      expect(target.updateWorkflowSettingValues).toHaveBeenCalledWith("WF-new", "target", { strict: true });
      expect(target.updateWorkflowPromptOverrides).toHaveBeenCalledWith("WF-new", "target", { step: "Custom prompt" });
    }
    expect(source.listTasks).not.toHaveBeenCalled();
    expect(target.createWorkflowDefinition).toHaveBeenCalledTimes(populated ? 1 : 0);
  });
});

it.each(['a:/old project/worktrees','A:/Old Project/worktrees','A:/Old Project/./worktrees'])('rebases equivalent Windows path %s',value=>{
 const copied=remapConfiguration({worktreesDir:value},new Map(),'A:/Old Project','A:/New Project');
 expect(copied.worktreesDir.split(String.fromCharCode(92)).join('/')).toBe('A:/New Project/worktrees');
});
it('preserves unrelated paths and prose and handles root identity and empty values',()=>{
 const value={root:'a:/old project',outside:'A:/Old Project Other/worktrees',escape:'A:/Old Project/../Elsewhere',prose:'Use A:/Old Project/worktrees',empty:null};
 expect(remapConfiguration(value,new Map(),'A:/Old Project','A:/New Project')).toEqual({...value,root:'A:/New Project'});
});
