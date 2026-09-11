import { beforeAll, beforeEach, afterEach, afterAll, expect, it } from "vitest";
import { drizzleEq as eq, beginProblemReportingSession, assertProblemReportingComplete, registerFusionSessionIdentity, __clearFusionSessionIdentityRegistryForTests, type WorkflowIrV2 } from "@fusion/core";
import { tasks, taskWorkflowSelection } from "../../../core/src/postgres/schema/project.js";
import { createPgExtensionHarness, createMockApi, registerExtension, requireTool, pgDescribe } from "./pg-extension-harness.js";
import { setHostTaskStore, __setExtensionStoreBootFactoryForTesting, __clearExtensionStoreBootStateForTesting } from "../extension.js";

// FNXC:ProblemReporting 2026-09-11-12:09: Verify the registered CLI surface with trusted engine identity and real transactions, including generation fencing and concurrent evidence retention.
pgDescribe("registered problem reporting with PostgreSQL", () => {
  const h = createPgExtensionHarness("problem-report-cli");
  beforeAll(h.beforeAll);
  beforeEach(async () => {
    await h.beforeEach();
    setHostTaskStore(h.rootDir(), h.store());
    __setExtensionStoreBootFactoryForTesting(async () => { throw new Error("Unexpected database boot"); });
  });
  afterEach(async () => {
    __clearFusionSessionIdentityRegistryForTests();
    __clearExtensionStoreBootStateForTesting();
    await h.afterEach();
  });
  afterAll(h.afterAll);

  it("creates, reads, deduplicates and finishes while ordinary creation and stale sessions remain blocked", async () => {
    const ir: WorkflowIrV2 = {
      version: "v2", name: "CLI testing",
      columns: ["testing", "problems", "resolved-problems"].map((id) => ({ id, name: id, traits: [] })),
      nodes: [{ id: "start", kind: "start", column: "testing" }, { id: "end", kind: "end", column: "testing" }], edges: [{ from: "start", to: "end" }],
      fields: ["record_type", "problem_type", "kit_path", "extension_path", "originating_task_id"].map((id) => ({ id, name: id, type: "text" })),
      problemReporting: { sourceColumns: ["testing"], openColumn: "problems", resolvedColumn: "resolved-problems" },
    };
    const workflow = await h.store().createWorkflowDefinition({ name: ir.name, ir });
    const layer = h.store().asyncLayer!;
    const projectId = layer.projectId!;
    const now = new Date().toISOString();
    await layer.db.insert(tasks).values({ projectId, id: "FN-ORIGIN", column: "testing", description: "Testing source", createdAt: now, updatedAt: now });
    await layer.db.insert(taskWorkflowSelection).values({ projectId, taskId: "FN-ORIGIN", workflowId: workflow.id, updatedAt: now });
    const sessionId = await beginProblemReportingSession(h.store(), "FN-ORIGIN");
    registerFusionSessionIdentity(h.rootDir(), { agentId: "tester", taskId: "FN-ORIGIN", taskExecutionSession: true, problemReportingSessionId: sessionId });
    const api = createMockApi();
    registerExtension(api);
    const tool = requireTool(api, "fn_problem_report");
    const call = (params: Record<string, unknown>) => tool.execute("call", params, undefined, undefined, { cwd: h.rootDir() });
    expect(await call({ action: "preflight" })).toMatchObject({ details: { available: true } });
    expect(await requireTool(api, "fn_task_create").execute("create", { description: "Unrestricted task" }, undefined, undefined, { cwd: h.rootDir() })).toMatchObject({ isError: true });
    await call({ action: "expect", requestIds: ["one", "two"] });
    expect(await call({ action: "finish", requestIds: ["one", "two"] })).toMatchObject({ isError: true });
    const reports = await Promise.all(["one", "two"].map((requestId) => call({ action: "report", report: {
      requestId, problemKey: "same-defect", problemType: "parity", title: "Parity defect", kitPath: "kit", extensionPath: "extension",
      reproduction: "Run paired fixtures", configuration: "Emulators", evidence: [requestId], extensionObservation: "Retains value", kitObservation: "Drops value",
    } })));
    expect(reports.every((result) => !result.isError)).toBe(true);
    const list = await call({ action: "list" });
    const survivor = (list.details!.tasks as Array<{ id: string }>)[0]!.id;
    expect(list.details!.tasks).toHaveLength(1);
    const observed: string[] = [];
    for (const observationOffset of [0, 1]) {
      const read = await call({ action: "read", id: survivor, observationOffset });
      expect(read).toMatchObject({ details: { customFields: { record_type: "problem", problem_type: "parity", originating_task_id: "FN-ORIGIN" } } });
      const observations = read.details!.observations as Array<{ input: { evidence: string[] } }>;
      observed.push(...observations[0]!.input.evidence);
    }
    expect(observed.sort()).toEqual(["one", "two"]);
    await layer.db.update(tasks).set({ column: "resolved-problems" }).where(eq(tasks.id, survivor));
    expect(await call({ action: "finish", requestIds: ["one", "two"] })).toMatchObject({ details: { finished: true } });
    await expect(assertProblemReportingComplete(h.store(), "FN-ORIGIN", sessionId)).resolves.toBeUndefined();
    await beginProblemReportingSession(h.store(), "FN-ORIGIN");
    expect(await call({ action: "preflight" })).toMatchObject({ isError: true });
    expect(await call({ action: "finish", requestIds: ["one", "two"] })).toMatchObject({ isError: true });
    expect(await call({ action: "list" })).toMatchObject({ isError: true });
  });
});
