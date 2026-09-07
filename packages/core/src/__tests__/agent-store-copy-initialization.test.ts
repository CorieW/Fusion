import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentStore } from "../agents/agent-store.js";
describe("agent store copy initialization", () => {
  it.each([true, false])("creates storage with provisionDefaults=%s", async provisionDefaults => {
    const root = await mkdtemp(join(tmpdir(), "fusion-agent-copy-init-"));
    try {
      const store = new AgentStore({ rootDir: root });
      const roles = vi.spyOn(store, "provisionBuiltinWorkflowRoleAgents").mockResolvedValue([]);
      const memory = vi.spyOn(store, "provisionBuiltinMemoryAgent").mockResolvedValue(undefined as never);
      await store.init(provisionDefaults ? undefined : { provisionDefaults: false });
      expect((await stat(join(root, "agents"))).isDirectory()).toBe(true);
      expect(roles).toHaveBeenCalledTimes(provisionDefaults ? 1 : 0);
      expect(memory).toHaveBeenCalledTimes(provisionDefaults ? 1 : 0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
