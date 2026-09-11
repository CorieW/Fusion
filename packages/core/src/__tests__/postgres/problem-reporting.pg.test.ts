import { beforeAll, beforeEach, afterAll, afterEach, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { pgDescribe, createSharedPgTaskStoreTestHarness } from "../../__test-utils__/pg-test-harness.js";
import { tasks, workflows, taskWorkflowSelection } from "../../postgres/schema/project.js";
import { beginProblemReportingSession, reportProblem, readProblemReports, updateProblemReportingLedger, assertProblemReportingComplete, problemReportingPreflight, type ProblemReportInput } from "../../tasks/problem-reporting.js";
import type { WorkflowIrV2 } from "../../workflows/workflow-ir-types.js";

/** FNXC:ProblemReporting 2026-09-11-11:22:
 * Exercise the original board-task blocker through real persisted workflows and tasks.
 * The database tests own cross-process serialization, atomic rollback and survivor readback;
 * tool/session tests own schema reachability and fail-closed completion behavior.
 */
pgDescribe("structured problem reporting", () => {
  const projectId = "problem-report-test";
  const h = createSharedPgTaskStoreTestHarness({ prefix: "problem_reporting", projectId });
  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);
  const input = (requestId: string, overrides: Partial<ProblemReportInput> = {}): ProblemReportInput => ({
    requestId, problemKey: "drops-null-property", problemType: "parity", title: "Null property disappears",
    kitPath: "kits/firestore", extensionPath: "extensions/firestore", reproduction: "Write a null property and compare output",
    configuration: "Local emulator, default configuration", evidence: [`observed:${requestId}`],
    extensionObservation: "Property retained", kitObservation: "Property absent", ...overrides,
  });
  const ir: WorkflowIrV2 = {
    version: "v2", name: "Parity testing",
    columns: ["testing", "problems", "resolved-problems"].map((id) => ({ id, name: id, traits: [] })),
    nodes: [{ id: "start", kind: "start", column: "testing" }, { id: "end", kind: "end", column: "testing" }],
    edges: [{ from: "start", to: "end" }],
    fields: ["record_type", "problem_type", "kit_path", "extension_path", "originating_task_id", "older_note"].map((id) => ({ id, name: id, type: "text" })),
    problemReporting: { sourceColumns: ["testing"], openColumn: "problems", resolvedColumn: "resolved-problems" },
  };
  async function seed(parentId = "FN-1", workflowId = "WF-TEST", project = projectId) {
    const now = "2026-09-11T10:00:00.000Z";
    await h.layer().db.insert(workflows).values({ projectId: project, id: workflowId, name: "Testing", ir, createdAt: now, updatedAt: now }).onConflictDoNothing();
    await h.layer().db.insert(tasks).values({ projectId: project, id: parentId, description: "Test parity", column: "testing", createdAt: now, updatedAt: now });
    await h.layer().db.insert(taskWorkflowSelection).values({ projectId: project, taskId: parentId, workflowId, updatedAt: now });
    return beginProblemReportingSession(h.store(), parentId);
  }
  const row = async (id: string) => (await h.layer().db.select().from(tasks).where(and(eq(tasks.projectId, projectId), eq(tasks.id, id))))[0]!;

  it("creates structured human-held records, reads evidence, and refuses incomplete ledgers", async () => {
    const session = await seed();
    await expect(problemReportingPreflight(h.store(), "FN-1")).resolves.toMatchObject({ available: true });
    await updateProblemReportingLedger(h.store(), "FN-1", ["finding-1"], false, session);
    await expect(updateProblemReportingLedger(h.store(), "FN-1", ["finding-1"], true, session)).rejects.toThrow("Missing mandatory");
    await expect(assertProblemReportingComplete(h.store(), "FN-1", session)).rejects.toThrow("cannot succeed");
    const receipt = await reportProblem(h.store(), "FN-1", input("finding-1"), session);
    const created = await h.store().getTask(receipt.createdTaskId);
    expect(created).toMatchObject({ column: "problems", paused: true, userPaused: true, autoMerge: false, sourceParentTaskId: "FN-1",
      customFields: { record_type: "problem", problem_type: "parity", kit_path: "kits/firestore", extension_path: "extensions/firestore", originating_task_id: "FN-1" } });
    expect(await h.store().getTaskWorkflowSelectionAsync(created.id)).toMatchObject({ workflowId: "WF-TEST" });
    expect(await readProblemReports(h.store(), "FN-1", { id: created.id })).toMatchObject({ observations: [{ input: input("finding-1") }], nextObservationOffset: null });
    await updateProblemReportingLedger(h.store(), "FN-1", ["finding-1"], true, session);
    await expect(assertProblemReportingComplete(h.store(), "FN-1", session)).resolves.toBeUndefined();
    await h.layer().db.update(tasks).set({ deletedAt: "2026-09-11T11:00:00.000Z" }).where(eq(tasks.id, created.id));
    await expect(assertProblemReportingComplete(h.store(), "FN-1", session)).rejects.toThrow("no live survivor");
  });

  it("retains newest open evidence, separates types/paths/identities, and follows deleted receipts", async () => {
    await seed();
    const old = await reportProblem(h.store(), "FN-1", input("old", { customFields: { older_note: "unique configuration note" } }));
    await h.layer().db.update(tasks).set({ description: "Human reproduction addendum", comments: [{ text: "A useful human observation" }] }).where(eq(tasks.id, old.createdTaskId));
    const newest = await reportProblem(h.store(), "FN-1", input("new"));
    expect(newest.deletedTaskIds).toEqual([old.createdTaskId]);
    expect((await row(old.createdTaskId)).deletedAt).toBeTruthy();
    const read = await readProblemReports(h.store(), "FN-1", { id: old.createdTaskId });
    expect(read).toMatchObject({ id: newest.createdTaskId, customFields: { older_note: "unique configuration note" }, nextObservationOffset: 1 });
    expect(await readProblemReports(h.store(), "FN-1", { id: newest.createdTaskId, observationOffset: 1 })).toMatchObject({ observations: [{ input: { evidence: ["observed:old"] }, retainedRecord: { description: "Human reproduction addendum", comments: [{ text: "A useful human observation" }] } }] });
    const retry = await reportProblem(h.store(), "FN-1", input("old", { customFields: { older_note: "unique configuration note" } }));
    expect(retry.survivingTaskId).toBe(newest.createdTaskId);
    for (const overrides of [{ problemType: "general" as const }, { kitPath: "other-kit" }, { extensionPath: "other-extension" }, { problemKey: "different-cause" }]) {
      const separate = await reportProblem(h.store(), "FN-1", input(JSON.stringify(overrides), overrides));
      expect(separate.deletedTaskIds).toEqual([]);
    }
    await expect(reportProblem(h.store(), "FN-1", input("new", { evidence: ["changed"] }))).rejects.toThrow("different evidence");
    await updateProblemReportingLedger(h.store(), "FN-1", ["old", "new", ...[{ problemType: "general" }, { kitPath: "other-kit" }, { extensionPath: "other-extension" }, { problemKey: "different-cause" }].map((value) => JSON.stringify(value))], true);
  });

  it("reads large structured evidence completely without tool-output truncation", async () => {
    await seed();
    const payload = input("large", { evidence: ["\u0001\n\"\\long evidence ".repeat(2_000)] });
    const receipt = await reportProblem(h.store(), "FN-1", payload);
    let contentOffset = 0;
    let contentHash: string | undefined;
    let content = "";
    for (;;) {
      const part = await readProblemReports(h.store(), "FN-1", { id: receipt.createdTaskId, contentOffset, contentHash });
      if (!("contentPart" in part) || typeof part.contentPart !== "string") throw new Error("expected content page");
      expect(JSON.stringify(part).length).toBeLessThanOrEqual(8_000);
      content += part.contentPart;
      contentHash = part.contentHash;
      if (part.nextContentOffset == null) break;
      contentOffset = part.nextContentOffset;
    }
    expect(JSON.parse(content)).toMatchObject({ observations: [{ input: payload }] });
    await expect(readProblemReports(h.store(), "FN-1", { id: receipt.createdTaskId, contentOffset: 4_000, contentHash: "stale" })).rejects.toThrow("changed during paging");
  });

  it("reads live human evidence and legacy records, and fences old generations after a workflow switch", async () => {
    const session = await seed();
    const report = await reportProblem(h.store(), "FN-1", input("human"), session);
    await h.layer().db.update(tasks).set({ description: "Human-only reproduction", comments: [{ text: "Human evidence" }], attachments: [{ path: "proof.txt" }] }).where(eq(tasks.id, report.createdTaskId));
    expect(await readProblemReports(h.store(), "FN-1", { id: report.createdTaskId }, session)).toMatchObject({ currentRecord: { description: "Human-only reproduction", comments: [{ text: "Human evidence" }], attachments: [{ path: "proof.txt" }] } });
    await h.layer().db.update(tasks).set({ sourceMetadata: null }).where(eq(tasks.id, report.createdTaskId));
    expect(await readProblemReports(h.store(), "FN-1", { id: report.createdTaskId }, session)).toMatchObject({ currentRecord: { description: "Human-only reproduction" }, observations: [] });
    await seed("FN-2", "WF-OTHER");
    await h.layer().db.update(taskWorkflowSelection).set({ workflowId: "WF-OTHER" }).where(eq(taskWorkflowSelection.taskId, "FN-1"));
    await expect(reportProblem(h.store(), "FN-1", input("wrong-workflow"), session)).rejects.toThrow("No active");
    const next = await beginProblemReportingSession(h.store(), "FN-1");
    await expect(readProblemReports(h.store(), "FN-1", {}, session)).rejects.toThrow("No active");
    await expect(updateProblemReportingLedger(h.store(), "FN-1", [], true, next)).resolves.toMatchObject({ finished: true, expected: [] });
    await h.layer().db.update(tasks).set({ nodeId: "end" }).where(eq(tasks.id, "FN-1"));
    await expect(problemReportingPreflight(h.store(), "FN-1", next)).rejects.toThrow("No active");
    await expect(assertProblemReportingComplete(h.store(), "FN-1", next)).rejects.toThrow("No active");
  });

  it("fills required null values from retained evidence or defaults and replays committed receipts after schema edits", async () => {
    await seed();
    const oldInput = input("old-field", { customFields: { older_note: "preserve me" } });
    const old = await reportProblem(h.store(), "FN-1", oldInput);
    const requiredIr: WorkflowIrV2 = { ...ir, fields: ir.fields!.map((field) => field.id === "older_note" ? { ...field, required: true, default: "fallback" } : field) };
    requiredIr.fields!.push({ id: "toString", name: "Display value", type: "text", required: true, default: "explicit default" });
    await h.layer().db.update(workflows).set({ ir: requiredIr }).where(eq(workflows.id, "WF-TEST"));
    const newest = await reportProblem(h.store(), "FN-1", input("null-field", { customFields: { older_note: null } }));
    expect((await row(newest.createdTaskId)).customFields).toMatchObject({ older_note: "preserve me" });
    const separate = await reportProblem(h.store(), "FN-1", input("default-field", { problemKey: "different", customFields: { older_note: null } }));
    expect((await row(separate.createdTaskId)).customFields).toMatchObject({ older_note: "fallback", toString: "explicit default" });
    await h.layer().db.update(workflows).set({ ir: { ...ir, fields: ir.fields!.filter((field) => field.id !== "older_note") } }).where(eq(workflows.id, "WF-TEST"));
    expect(await reportProblem(h.store(), "FN-1", oldInput)).toMatchObject({ createdTaskId: old.createdTaskId, survivingTaskId: newest.createdTaskId });
    await expect(reportProblem(h.store(), "FN-1", input("unknown", { customFields: { older_note: "now removed" } }))).rejects.toThrow("not declared");
  });

  it("gives resolved matches precedence without mutating resolved or existing open records", async () => {
    await seed();
    const resolved = await reportProblem(h.store(), "FN-1", input("resolved"));
    await h.layer().db.update(tasks).set({ column: "resolved-problems" }).where(eq(tasks.id, resolved.createdTaskId));
    const before = await row(resolved.createdTaskId);
    // Seed an open duplicate from a previously independent import; a resolved match must not touch it.
    await h.layer().db.insert(tasks).values({ ...before, id: "PRB-legacy-open", column: "problems" });
    await h.layer().db.insert(taskWorkflowSelection).values({ projectId, taskId: "PRB-legacy-open", workflowId: "WF-TEST", updatedAt: before.updatedAt });
    const result = await reportProblem(h.store(), "FN-1", input("incoming"));
    expect(result).toMatchObject({ survivingTaskId: resolved.createdTaskId, matchedResolvedTaskId: resolved.createdTaskId, deletedTaskIds: [result.createdTaskId] });
    expect(await row(resolved.createdTaskId)).toEqual(before);
    expect((await row("PRB-legacy-open")).deletedAt).toBeNull();
    expect((await row(result.createdTaskId)).deletedAt).toBeTruthy();
    expect(await reportProblem(h.store(), "FN-1", input("incoming"))).toEqual(result);
  });

  it("serializes concurrent reports/retries across parents and never crosses project/workflow scope", async () => {
    await seed("FN-1");
    await seed("FN-2");
    await seed("FN-3", "WF-OTHER");
    const results = await Promise.all([
      reportProblem(h.store(), "FN-1", input("one")),
      reportProblem(h.store(), "FN-2", input("two")),
      reportProblem(h.store(), "FN-1", input("one")),
    ]);
    expect(new Set(results.map((result) => result.createdTaskId)).size).toBe(2);
    const list = await readProblemReports(h.store(), "FN-1");
    expect("tasks" in list && list.tasks).toHaveLength(1);
    const survivor = "tasks" in list ? list.tasks![0]!.id : "";
    expect(await readProblemReports(h.store(), "FN-1", { id: survivor })).toMatchObject({ nextObservationOffset: 1 });
    const other = await reportProblem(h.store(), "FN-3", input("other"));
    expect(other.deletedTaskIds).toEqual([]);
    await expect(readProblemReports(h.store(), "FN-1", { id: other.createdTaskId })).rejects.toThrow("no live survivor");
    const own = await row(survivor);
    await h.layer().db.insert(tasks).values({ ...own, projectId: "other-project", id: "PRB-foreign" });
    await h.layer().db.insert(taskWorkflowSelection).values({ projectId: "other-project", taskId: "PRB-foreign", workflowId: "WF-TEST", updatedAt: own.updatedAt });
    expect(await readProblemReports(h.store(), "FN-1")).toMatchObject({ tasks: [{ id: survivor }] });
  });

  it("rolls back creation, evidence merging, deletions and ledger on a late transaction failure", async () => {
    await seed();
    const old = await reportProblem(h.store(), "FN-1", input("old"));
    const before = await row(old.createdTaskId);
    const layer = h.layer();
    const original = layer.transactionImmediate.bind(layer);
    const injection = vi.spyOn(layer, "transactionImmediate").mockImplementation((fn) => original(async (tx) => { await fn(tx); throw new Error("injected before commit"); }));
    await expect(reportProblem(h.store(), "FN-1", input("new"))).rejects.toThrow("injected before commit");
    injection.mockRestore();
    expect(await row(old.createdTaskId)).toEqual(before);
    expect(await readProblemReports(h.store(), "FN-1")).toMatchObject({ tasks: [{ id: old.createdTaskId }], nextCursor: null });
    const retried = await reportProblem(h.store(), "FN-1", input("new"));
    expect(retried.deletedTaskIds).toEqual([old.createdTaskId]);
  });

  it("paginates all custom-column records and blocks unauthorized sessions and undeclared fields", async () => {
    const session = await seed();
    const first = await reportProblem(h.store(), "FN-1", input("first"));
    const template = await row(first.createdTaskId);
    const ids = Array.from({ length: 52 }, (_, index) => `PRB-page-${String(index).padStart(3, "0")}`);
    await h.layer().db.insert(tasks).values(ids.map((id, index) => ({ ...template, id, column: index % 2 ? "problems" : "resolved-problems" })));
    await h.layer().db.insert(taskWorkflowSelection).values(ids.map((id) => ({ projectId, taskId: id, workflowId: "WF-TEST", updatedAt: template.updatedAt })));
    const seen: string[] = [];
    let after: string | undefined;
    do {
      const page = await readProblemReports(h.store(), "FN-1", { after });
      if (!("tasks" in page)) throw new Error("expected list");
      seen.push(...page.tasks!.map((entry) => entry.id));
      after = page.nextCursor ?? undefined;
    } while (after);
    expect(new Set(seen).size).toBe(53);
    await expect(reportProblem(h.store(), "FN-1", input("bad", { customFields: { undeclared: "no" } }))).rejects.toThrow("not declared");
    await expect(reportProblem(h.store(), "FN-1", input("unpaired", { kitObservation: "" }))).rejects.toThrow("paired");
    await expect(readProblemReports(h.store(), "FN-1", { column: "testing" })).rejects.toThrow("outside");
    const nextSession = await beginProblemReportingSession(h.store(), "FN-1");
    await expect(reportProblem(h.store(), "FN-1", input("stale"), session)).rejects.toThrow("No active");
    await expect(updateProblemReportingLedger(h.store(), "FN-1", [], true, nextSession)).rejects.toThrow("every expected and reported");
    await updateProblemReportingLedger(h.store(), "FN-1", ["first"], true, nextSession);
    await expect(assertProblemReportingComplete(h.store(), "FN-1", nextSession)).resolves.toBeUndefined();
    await h.layer().db.update(tasks).set({ column: "problems" }).where(eq(tasks.id, "FN-1"));
    await expect(reportProblem(h.store(), "FN-1", input("unauthorized"))).rejects.toThrow("no longer authorized");
    await h.layer().db.update(workflows).set({ ir: { ...ir, problemReporting: undefined } }).where(eq(workflows.id, "WF-TEST"));
    expect(await problemReportingPreflight(h.store(), "FN-1")).toMatchObject({ available: false });
  });
});
