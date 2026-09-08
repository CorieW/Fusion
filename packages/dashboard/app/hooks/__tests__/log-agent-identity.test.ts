import { describe, expect, it } from "vitest";
import type { AgentLogEntry } from "@fusion/core";
import { appendWithoutDuplicates, findLogWindowOverlap } from "../logStreamReconcile";

describe("agent identity during transcript reconciliation", () => {
  const coder: AgentLogEntry = { timestamp: "2026-09-08T00:00:00Z", taskId: "TASK-1", type: "text", text: "Done", agent: "executor", agentId: "coder", agentName: "Kit Parity Coder" };
  it("retains identical messages from distinct agents and deduplicates repeated delivery", () => {
    const tester = { ...coder, agentId: "tester", agentName: "Kit Parity Tester" };
    expect(findLogWindowOverlap([coder], [tester])).toBe(0);
    expect(appendWithoutDuplicates([coder], [tester])).toEqual([coder, tester]);
    expect(appendWithoutDuplicates([coder, tester], [tester])).toEqual([coder, tester]);
    expect(findLogWindowOverlap([coder], [{ ...coder, agentId: "other" }])).toBe(0);
  });
});
