import { afterEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { registerFusionSessionIdentity, __clearFusionSessionIdentityRegistryForTests, type TaskStore } from "@fusion/core";
import { setHostTaskStore, __setExtensionStoreBootFactoryForTesting, __clearExtensionStoreBootStateForTesting, closeCachedStores } from "../extension.js";
import { createMockApi, registerExtension, requireTool } from "./pg-extension-harness.js";

afterEach(async () => {
  __clearFusionSessionIdentityRegistryForTests();
  await closeCachedStores();
  __clearExtensionStoreBootStateForTesting();
});
describe("extension structured problem reporting", () => {
  const cwd = resolve(tmpdir(), "fusion-problem-report-extension-test");
  const registered = () => {
    __setExtensionStoreBootFactoryForTesting(async () => { throw new Error("Unexpected store boot in reporting unit test"); });
    const api = createMockApi(); registerExtension(api); return api;
  };
  it("binds preflight to the registered board task and rejects ordinary/ambiguous callers", async () => {
    const getSelection = vi.fn().mockResolvedValue(undefined);
    setHostTaskStore(cwd, { getTaskWorkflowSelectionAsync: getSelection } as unknown as TaskStore);
    const tool = requireTool(registered(), "fn_problem_report");
    const execute = (params = {}) => tool.execute("call", { action: "preflight", ...params }, undefined, undefined, { cwd });
    expect(await execute()).toMatchObject({ isError: true });
    expect(getSelection).not.toHaveBeenCalled();
    const dispose = registerFusionSessionIdentity(cwd, { agentId: "tester", taskId: "FN-ORIGIN", taskExecutionSession: true });
    expect(await execute({ sourceTaskId: "FN-OTHER" })).toMatchObject({ details: { available: false } });
    expect(getSelection).toHaveBeenCalledWith("FN-ORIGIN");
    expect(await execute({ action: "finish", requestIds: [], sessionId: "model-forged" })).toMatchObject({ isError: true });
    const disposeOther = registerFusionSessionIdentity(cwd, { agentId: "other-tester", taskId: "FN-OTHER", taskExecutionSession: true });
    expect(await execute()).toMatchObject({ isError: true });
    disposeOther();
    dispose();
  });
  it("enumerates custom open and resolved columns with usable cursors", async () => {
    const rows = ["problems", "resolved-problems"].flatMap((column) => Array.from({ length: 27 }, (_, index) => ({
      id: `${column}-${String(index).padStart(3, "0")}`, title: `Finding ${index}`, description: "Evidence", column, dependencies: [],
    })));
    setHostTaskStore(cwd, { listTasks: vi.fn().mockResolvedValue(rows) } as unknown as TaskStore);
    const tool = requireTool(registered(), "fn_task_list");
    for (const column of ["problems", "resolved-problems"]) {
      const first = await tool.execute("first", { column, limit: 25 }, undefined, undefined, { cwd });
      const cursor = first.details.nextCursorByColumn[column];
      expect(cursor).toBe(`${column}-024`);
      expect(first.content[0].text).toContain(`${column}-000`);
      const last = await tool.execute("last", { column, limit: 25, after: cursor }, undefined, undefined, { cwd });
      expect(last.content[0].text).toContain(`${column}-026`);
      expect(last.details.nextCursorByColumn[column]).toBeNull();
    }
  });
  it("does not advance the cursor past task IDs hidden by the text budget", async () => {
    const rows = Array.from({ length: 4 }, (_, index) => ({ id: `PRB-${index}`, title: "long title ".repeat(400), description: "Evidence", column: "problems", dependencies: [] }));
    setHostTaskStore(cwd, { listTasks: vi.fn().mockResolvedValue(rows) } as unknown as TaskStore);
    const tool = requireTool(registered(), "fn_task_list");
    const seen = new Set<string>();
    let after: string | undefined;
    do {
      const page = await tool.execute("page", { column: "problems", after }, undefined, undefined, { cwd });
      rows.filter((row) => page.content[0].text.includes(`${row.id}  `)).forEach((row) => seen.add(row.id));
      after = page.details.nextCursorByColumn.problems ?? undefined;
    } while (after);
    expect([...seen]).toEqual(rows.map((row) => row.id));
  });
});
