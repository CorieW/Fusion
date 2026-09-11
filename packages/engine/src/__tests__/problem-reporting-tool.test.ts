import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import { createProblemReportTool, problemReportParameters } from "../problem-reporting-tool.js";
import { Compile } from "typebox/compile";
import { filterCustomToolsForReadonly } from "../workflows/workflow-step-tool-policy.js";

const seams = vi.hoisted(() => ({ preflight: vi.fn(), report: vi.fn(), read: vi.fn(), ledger: vi.fn() }));
vi.mock("@fusion/core", () => ({ problemReportingPreflight: seams.preflight, reportProblem: seams.report, readProblemReports: seams.read, updateProblemReportingLedger: seams.ledger }));
const store = {} as TaskStore;
const tool = createProblemReportTool(store, "FN-SOURCE", "trusted-session");
const execute = (params: Record<string, unknown>) => tool.execute("call", params as never, undefined, undefined, {} as never);
beforeEach(() => vi.resetAllMocks());
describe("shared engine and extension problem reporting tool", () => {
  it("survives both readonly filters by factory identity, without admitting a name-only impostor", () => {
    const impostor = { ...tool };
    const first = filterCustomToolsForReadonly([tool, impostor]);
    expect(first.allowed).toEqual([tool]);
    expect(filterCustomToolsForReadonly(first.allowed).allowed).toEqual([tool]);
  });
  it("accepts custom fields and arbitrary custom-column names in the exposed schema", () => {
    const validator = Compile(problemReportParameters);
    expect(validator.Check({ action: "list", column: "resolved-problems", after: "PRB-1" })).toBe(true);
    expect(validator.Check({ action: "report", report: { requestId: "r", problemKey: "k", problemType: "general", title: "t", kitPath: "k", extensionPath: "e", reproduction: "steps", configuration: "config", evidence: ["proof"], customFields: { declared_extra: "value" } } })).toBe(true);
  });
  it("binds the source and generation from the session and surfaces authorization failures", async () => {
    seams.report.mockRejectedValue(new Error("not authorized"));
    const result = await execute({ action: "report", sourceTaskId: "FN-FOREIGN", report: { requestId: "r" } });
    expect(result).toMatchObject({ isError: true });
    expect(seams.report).toHaveBeenCalledWith(store, "FN-SOURCE", { requestId: "r" }, "trusted-session");
    expect(seams.ledger).toHaveBeenCalledWith(store, "FN-SOURCE", ["r"], false, "trusted-session");
  });
  it("makes missing capabilities detectable before reports", async () => {
    seams.preflight.mockResolvedValue({ available: false, reason: "not enabled" });
    expect(await execute({ action: "preflight" })).toMatchObject({ details: { available: false } });
    expect(seams.report).not.toHaveBeenCalled();
  });
  it("requires an explicit final ledger and returns verified outcome IDs", async () => {
    expect(await execute({ action: "finish" })).toMatchObject({ isError: true });
    seams.ledger.mockResolvedValue({ finished: true, receipts: {} });
    expect(await execute({ action: "finish", requestIds: [] })).toMatchObject({ details: { finished: true } });
    expect(seams.ledger).toHaveBeenCalledWith(store, "FN-SOURCE", [], true, "trusted-session");
  });
  it("preserves list and evidence pagination cursors", async () => {
    seams.read.mockResolvedValue({ nextCursor: "next" });
    expect(await execute({ action: "list", column: "problems", after: "prior" })).toMatchObject({ details: { nextCursor: "next" } });
    expect(seams.read).toHaveBeenLastCalledWith(store, "FN-SOURCE", { column: "problems", after: "prior" }, "trusted-session");
    await execute({ action: "read", id: "PRB-1", observationOffset: 12 });
    expect(seams.read).toHaveBeenLastCalledWith(store, "FN-SOURCE", { id: "PRB-1", observationOffset: 12 }, "trusted-session");
  });
  it("refuses every action except unavailable preflight when no engine generation was granted", async () => {
    const unbound = createProblemReportTool(store, "FN-SOURCE");
    seams.preflight.mockResolvedValue({ available: true });
    const call = (action: string) => unbound.execute("call", { action } as never, undefined, undefined, {} as never);
    expect(await call("preflight")).toMatchObject({ details: { available: false } });
    for (const action of ["expect", "report", "list", "read", "finish"]) expect(await call(action)).toMatchObject({ isError: true });
    expect(seams.report).not.toHaveBeenCalled();
    expect(seams.ledger).not.toHaveBeenCalled();
    expect(seams.read).not.toHaveBeenCalled();
  });
});
