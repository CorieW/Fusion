// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Agent, AgentStore } from "@fusion/core";
import { duplicateAgentConfiguration } from "../duplicate-agent.js";
import { duplicateName } from "../duplicate-name.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function fakeStore() {
  let saved: Agent;
  const store = {
    createAgent: vi.fn(async input => saved = { ...input, id: "agent-copy", state: "active", createdAt: "new", updatedAt: "new", heartbeatProcedurePath: ".fusion/agents/agent-copy/HEARTBEAT.md" }),
    updateAgentState: vi.fn(async (_id, state) => saved = { ...saved, state }),
    updateAgent: vi.fn(async (_id, updates) => saved = { ...saved, ...updates }),
    getAgent: vi.fn(async () => saved),
    listBundleFiles: vi.fn(async () => ["AGENTS.md"]),
    readBundleFile: vi.fn(async () => "Custom bundle"),
    writeBundleFile: vi.fn(async () => {}),
    setBundleConfig: vi.fn(async (_id, bundleConfig) => saved = { ...saved, bundleConfig }),
    deleteAgent: vi.fn(async () => {}),
  };
  return store;
}
const source = { id: "agent-source", name: "Reviewer", roles: ["reviewer"], role: "reviewer", state: "running", taskId: "TASK-1", totalInputTokens: 900, metadata: { builtinRole: "reviewer", lastRunId: "run-1", customLabel: "Team" }, runtimeConfig: { model: "test/model", enabled: true }, permissions: { read: true }, instructionsText: "Review carefully", soul: "Thorough", memory: "Past task", createdAt: "old", updatedAt: "old" } as Agent;
describe("agent duplication", () => {
  it("copies configuration without identity, task, memory, runtime history or automatic execution", async () => {
    const store = fakeStore();
    const before = structuredClone(source);
    const copy = await duplicateAgentConfiguration(source, store as unknown as AgentStore, store as unknown as AgentStore, "/source", "/target", "Reviewer (copy)");
    expect(copy).toMatchObject({ id: "agent-copy", name: "Reviewer (copy)", state: "paused", roles: ["reviewer"], instructionsText: "Review carefully", soul: "Thorough", runtimeConfig: { model: "test/model", enabled: false }, metadata: { customLabel: "Team" } });
    for (const key of ["taskId", "totalInputTokens", "memory"]) expect(copy).not.toHaveProperty(key);
    expect(copy.metadata).not.toHaveProperty("builtinRole");
    expect(copy.metadata).not.toHaveProperty("lastRunId");
    expect(source).toEqual(before);
  });
  it("copies instruction and heartbeat files to independent paths and materializes bundles", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-duplicate-test-")); roots.push(root);
    await mkdir(join(root, "source")); await mkdir(join(root, "target"));
    await writeFile(join(root, "source", "instructions.md"), "Source instructions");
    await writeFile(join(root, "source", "heartbeat.md"), "Custom heartbeat");
    const store = fakeStore();
    const copy = await duplicateAgentConfiguration({ ...source, instructionsPath: "instructions.md", heartbeatProcedurePath: "heartbeat.md", bundleConfig: { mode: "managed", entryFile: "AGENTS.md", files: ["AGENTS.md"] } }, store as unknown as AgentStore, store as unknown as AgentStore, join(root, "source"), join(root, "target"), "Copy");
    expect(await readFile(join(root, "target", copy.instructionsPath!), "utf8")).toBe("Source instructions");
    expect(await readFile(join(root, "target", copy.heartbeatProcedurePath!), "utf8")).toBe("Custom heartbeat");
    expect(store.writeBundleFile).toHaveBeenCalledWith("agent-copy", "AGENTS.md", "Custom bundle");
    expect(copy.bundleConfig).toEqual({ mode: "managed", entryFile: "AGENTS.md", files: ["AGENTS.md"] });
    await writeFile(join(root, "target", copy.instructionsPath!), "Changed copy");
    expect(await readFile(join(root, "source", "instructions.md"), "utf8")).toBe("Source instructions");
  });
  it("removes only the newly created agent when materializing its bundle fails", async () => {
    const store = fakeStore(); store.writeBundleFile.mockRejectedValueOnce(new Error("disk full"));
    await expect(duplicateAgentConfiguration({ ...source, bundleConfig: { mode: "managed", entryFile: "AGENTS.md", files: ["AGENTS.md"] } }, store as unknown as AgentStore, store as unknown as AgentStore, "/source", "/target", "Copy")).rejects.toThrow("disk full");
    expect(store.deleteAgent).toHaveBeenCalledExactlyOnceWith("agent-copy");
  });
  it("refuses task workers", async () => {
    const store = fakeStore();
    await expect(duplicateAgentConfiguration({ ...source, metadata: { taskWorker: true } }, store as unknown as AgentStore, store as unknown as AgentStore, "/source", "/target", "Copy")).rejects.toThrow("permanent");
    expect(store.createAgent).not.toHaveBeenCalled();
  });
  it("chooses collision-free names without changing the source name", () => {
    expect(duplicateName("Review", ["Review (copy)", "REVIEW (COPY 2)"])).toBe("Review (copy 3)");
  });
});
