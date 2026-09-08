import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentLogEntry } from "../types.js";
import type { TaskStore } from "../store.js";
import { appendAgentLogEntriesSync, readAgentLogEntries } from "../agents/agent-log-file-store.js";
import { appendAgentLogBatchImpl, flushAgentLogBufferImpl } from "../task-store/agent-logs.js";
import { appendAgentLogImpl } from "../task-store/workflow-integrity.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function directory() { const root = mkdtempSync(join(tmpdir(), "fusion-agent-log-identity-")); roots.push(root); return root; }

describe("agent log identity persistence", () => {
  it.each(["single", "batch"] as const)("preserves identity in %s writes, live events, and history", async (mode) => {
    const root = directory();
    const emit = vi.fn();
    const store = { backendMode: true, taskDir: () => root, agentLogBuffer: [], agentLogFlushTimer: null, emit, scanAndRecordCitations: () => [], flushAgentLogBuffer: () => flushAgentLogBufferImpl(store as unknown as TaskStore) };
    const identity = { agentId: "coder", agentName: "Kit Parity Coder" };
    if (mode === "single") {
      await appendAgentLogImpl(store as unknown as TaskStore, "TASK-1", "visible", "text", undefined, "executor", identity);
      store.flushAgentLogBuffer();
    } else {
      await appendAgentLogBatchImpl(store as unknown as TaskStore, [{ taskId: "TASK-1", text: "visible", type: "text", agent: "executor", ...identity }]);
    }
    expect(emit).toHaveBeenCalledWith("agent:log", expect.objectContaining(identity));
    expect(readAgentLogEntries(root)).toEqual([expect.objectContaining({ ...identity, agent: "executor", text: "visible" })]);
  });

  it("preserves legacy rows and normalizes empty or invalid identity metadata", () => {
    const root = directory();
    const base: AgentLogEntry = { taskId: "TASK-1", timestamp: "2026-09-08T00:00:00Z", type: "text", text: "legacy", agent: "reviewer" };
    appendAgentLogEntriesSync(root, [base, { ...base, agentId: " ", agentName: " " }, { ...base, agentId: 42, agentName: {} } as unknown as AgentLogEntry]);
    for (const entry of readAgentLogEntries(root)) {
      expect(entry).toMatchObject(base);
      expect(entry).not.toHaveProperty("agentId");
      expect(entry).not.toHaveProperty("agentName");
    }
  });
});
