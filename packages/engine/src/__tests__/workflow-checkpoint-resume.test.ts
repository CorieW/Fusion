import { afterEach, describe, expect, it, vi } from "vitest";
import type { Settings, TaskDetail, WorkflowIr, WorkflowIrNode } from "@fusion/core";
import { runAwaitInputNode } from "../executor/await-input-node.js";
import { runGraphCustomNode } from "../executor/run-graph-custom-node.js";
import { resolveWorkflowInputMarkerForGraphNode } from "../executor/workflow-input-markers.js";
import { resolveResumeLanes } from "../executor/resolve-resume-lanes.js";
import { wireExecutorLifecycle } from "../executor/wire-executor-lifecycle.js";
import { dispatchUnpauseResume } from "../executor/unpause-resume.js";
import { resumeApprovalAfterUnwindIfNeeded } from "../executor/resume-approval-after-unwind.js";
import { WorkflowGraphExecutor } from "../workflows/workflow-graph-executor.js";
import { registerWorkflowRoutes } from "../../../dashboard/src/routes/register-workflow-routes.js";

const NOW = Date.parse("2026-09-08T12:00:00Z");
const columns = ["coding", "review", "testing"];
const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.useRealTimers();
});

function fixture(column = "testing", kind: "ask-user" | "prompt" = "ask-user") {
  vi.useFakeTimers({ now: NOW });
  let row = {
    id: "WORK-004", column, description: "Parity", currentStep: 0,
    steps: [], steeringComments: [], workflowStepResults: [],
  } as unknown as TaskDetail;
  const ask: WorkflowIrNode = {
    id: "human-completion", kind, column,
    config: { question: "Reply DONE", ...(kind === "prompt" ? { awaitInput: true } : {}), reworkRegion: true },
  };
  const ir: WorkflowIr = {
    version: "v2", name: "Parity",
    columns: [
      { id: "todo", name: "Todo", traits: [{ trait: "intake", config: { autoTriage: false } }] },
      ...columns.map((id) => ({ id, name: id, traits: [{ trait: "wip" as const }] })),
      { id: "done", name: "Done", traits: [{ trait: "complete" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "todo" }, ask,
      { id: "decision", kind: "exit-gate", column, config: {
        condition: { type: "output-matches", nodeId: ask.id, pattern: "^\\s*DONE\\s*$", flags: "i" },
      } },
      { id: "end", kind: "end", column: "done" },
    ],
    edges: [
      { from: "start", to: ask.id }, { from: ask.id, to: "decision", condition: "success" },
      { from: "decision", to: "end", condition: "outcome:exit" },
      { from: "decision", to: ask.id, condition: "outcome:continue", kind: "rework" },
    ],
  };
  const handlers = new Map<string, (task: TaskDetail) => Promise<void>>();
  const store = {
    on: vi.fn((event: string, callback: (task: TaskDetail) => Promise<void>) => handlers.set(event, callback)),
    getTask: vi.fn(async () => structuredClone(row)),
    updateTask: vi.fn(async (_id: string, patch: Partial<TaskDetail>) => {
      row = { ...row, ...patch };
      return structuredClone(row);
    }),
    logEntry: vi.fn(async () => undefined),
    getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "parity", stepIds: [] })),
    getWorkflowDefinition: vi.fn(async () => ({ id: "parity", ir })),
  };
  const shared = { store: store as never, getRunContextFor: () => undefined };
  const customDeps = {
    ...shared,
    resolveWorkflowInputMarkerForGraphNode: (task: TaskDetail, nodeId: string) =>
      resolveWorkflowInputMarkerForGraphNode(shared, task, nodeId),
    runAwaitInputNode: (node: WorkflowIrNode, task: TaskDetail) => runAwaitInputNode(shared, node, task),
  };
  const runCustom = (node = ask) => runGraphCustomNode(customDeps as never, node, structuredClone(row), {} as Settings);
  const graph = new WorkflowGraphExecutor({ runCustomNode: (node) => runCustom(node) });
  const runGraph = () => graph.run(structuredClone(row), {}, ir, ask.id);
  const execution = vi.fn(async (_task: TaskDetail) => {
    const result = await runGraph();
    if (result.outcome === "success") await store.updateTask(row.id, { column: "done" });
    return result;
  });
  const deps = {
    ...shared, options: {}, rootDir: "/synthetic",
    executing: new Set<string>(), resumingUnpaused: new Set<string>(), recoveringCompleted: new Set<string>(),
    approvalSuspended: new Set<string>(), approvalResumeAfterUnwind: new Set<string>(), graphRouting: new Set<string>(),
    activeSessions: new Map(), activeStepExecutors: new Map(), activeWorkflowStepSessions: new Map(),
    activeConfiguredCommandControllers: new Map(), graphSeamGoverningNodeId: new Map(), graphColumnAgentResolver: new Map(),
    getExecutionPauseLabel: vi.fn(async (): Promise<string | null> => null),
    clearResumeFailureState: vi.fn(async () => undefined), recoverApprovedStepsOnResume: vi.fn(async () => undefined),
    recoverCompletedTask: vi.fn(async () => true), execute: execution,
    resolveResumeLanes: (taskId: string) => resolveResumeLanes(shared, taskId),
    dispatchUnpauseResume: (task: TaskDetail) => dispatchUnpauseResume(deps as never, task),
  };
  const wired = wireExecutorLifecycle(deps as never);
  if (wired.unregisterTaskMoveDisposer) disposers.push(wired.unregisterTaskMoveDisposer);
  const updateEvent = () => handlers.get("task:updated")!(structuredClone(row));
  const reply = async (text = "DONE") => {
    await store.updateTask(row.id, {
      paused: false, status: null,
      steeringComments: [{ id: "reply", text, author: "user", createdAt: new Date(NOW).toISOString() }],
    });
  };
  return { ask, ir, store, shared, deps, runCustom, runGraph, reply, updateEvent, get row() { return row; } };
}

describe("checkpoint answer ownership", () => {
  it.each(["ask-user", "prompt"] as const)("consumes DONE through the real custom runner for %s", async (kind) => {
    const h = fixture("testing", kind);
    await expect(h.runCustom()).resolves.toMatchObject({ value: "awaiting-user-input" });
    await h.reply();
    await expect(h.runCustom()).resolves.toMatchObject({
      outcome: "success", contextPatch: { "input:human-completion": "DONE" },
    });
    expect(h.row.pausedReason).toBeNull();
  });

  it("does not consume a marker owned by a node with a longer matching prefix", async () => {
    const h = fixture();
    await h.store.updateTask(h.row.id, {
      paused: false, pausedReason: `workflow-input:human-completion-extra@${NOW}: other question`,
    });
    await h.reply();
    await expect(runAwaitInputNode(h.shared, h.ask, h.row)).resolves.toMatchObject({ value: "awaiting-user-input" });
  });

  it.each(["missing", "stale", "invalid-date", "paused", "user-paused"])("keeps %s input parked", async (state) => {
    const h = fixture();
    await h.runCustom();
    await h.reply();
    await h.store.updateTask(h.row.id, {
      ...(state === "missing" ? { steeringComments: [] } : {}),
      ...(state === "stale" || state === "invalid-date" ? { steeringComments: [{
        id: "old", text: "DONE", author: "user", createdAt: state === "stale" ? new Date(NOW - 1).toISOString() : "invalid",
      }] } : {}),
      ...(state === "paused" ? { paused: true } : {}),
      ...(state === "user-paused" ? { userPaused: true } : {}),
    });
    await expect(h.runCustom()).resolves.toMatchObject({ value: "awaiting-user-input" });
    expect(h.row.paused).toBe(true);
  });

  it("clears an answered marker only when entering another node", async () => {
    const h = fixture();
    await h.runCustom();
    await h.reply();
    await expect(resolveWorkflowInputMarkerForGraphNode(h.shared, h.row, "different-step")).resolves.toBe("clear");
    expect(h.row.pausedReason).toBeNull();
  });
});

describe("checkpoint resume integration", () => {
  it("submits a reply through the real workflow input route and completes the graph", async () => {
    const h = fixture();
    await h.runGraph();
    const update = h.store.updateTask.getMockImplementation()!;
    h.store.updateTask.mockImplementation(async (id, patch) => {
      const result = await update(id, patch);
      await h.updateEvent();
      return result;
    });
    const routeStore = {
      ...h.store,
      addSteeringComment: vi.fn(async (id: string, text: string) => h.store.updateTask(id, {
        steeringComments: [{ id: "http-reply", text, author: "user", createdAt: new Date(NOW).toISOString() }],
      })),
    };
    const post = vi.fn();
    registerWorkflowRoutes({
      router: { get: vi.fn(), post, put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
      options: {}, getProjectContext: async () => ({ store: routeStore }),
      rethrowAsApiError: (err: unknown) => { throw err; },
    } as never);
    const handler = post.mock.calls.find(([path]) => path === "/tasks/:taskId/workflow/input")![1];
    const json = vi.fn();
    await handler({ params: { taskId: h.row.id }, body: { text: " DONE " } }, { json });
    expect(json).toHaveBeenCalledWith({ ok: true });
    expect(routeStore.addSteeringComment).toHaveBeenCalledWith(h.row.id, "DONE");
    expect(h.deps.execute).toHaveBeenCalledOnce();
    await h.deps.execute.mock.results[0].value;
    expect(h.row).toMatchObject({ column: "done", pausedReason: null });
  });

  it.each(columns)("reply in %s advances the real graph through DONE to completion", async (column) => {
    const h = fixture(column);
    await h.runGraph();
    expect(h.row.paused).toBe(true);
    await h.reply();
    await h.updateEvent();
    expect(h.deps.execute).toHaveBeenCalledOnce();
    await expect(h.deps.execute.mock.results[0].value).resolves.toMatchObject({
      outcome: "success", context: { "input:human-completion": "DONE", "node:decision:value": "exit" },
    });
    expect(h.row.column).toBe("done");
    expect(h.row.pausedReason).toBeNull();
  });

  it("keeps the task in Testing after a non-DONE answer and accepts a later DONE", async () => {
    const h = fixture();
    await h.runGraph();
    await h.reply("not yet");
    await h.updateEvent();
    expect(h.deps.execute).toHaveBeenCalledOnce();
    await h.deps.execute.mock.results[0].value;
    expect(h.row).toMatchObject({ column: "testing", paused: true });
    await h.reply("DONE");
    await h.updateEvent();
    await h.deps.execute.mock.results[1].value;
    expect(h.row.column).toBe("done");
  });

  it("runs the pending checkpoint even when coding checklist steps are done", async () => {
    const h = fixture("coding");
    await h.runGraph();
    await h.reply();
    await h.store.updateTask(h.row.id, { steps: [{ id: "0", title: "Implement", status: "done" }] as never });
    await h.updateEvent();
    expect(h.deps.recoverCompletedTask).not.toHaveBeenCalled();
    expect(h.deps.execute).toHaveBeenCalledOnce();
    await h.deps.execute.mock.results[0].value;
    expect(h.row.column).toBe("done");
  });

  it.each(["todo", "done", "unknown"])("never dispatches from non-WIP column %s", async (column) => {
    const h = fixture(column);
    await h.reply();
    await h.updateEvent();
    expect(h.deps.execute).not.toHaveBeenCalled();
  });

  it.each(["paused", "userPaused", "deletedAt", "failed", "enginePause"])("honors %s on a resumed checkpoint", async (guard) => {
    const h = fixture("coding");
    await h.runGraph();
    await h.reply();
    if (guard === "enginePause") h.deps.getExecutionPauseLabel.mockResolvedValue("engine paused");
    else await h.store.updateTask(h.row.id, guard === "failed" ? { status: "failed" }
      : guard === "deletedAt" ? { deletedAt: new Date(NOW).toISOString() } : { [guard]: true });
    await h.updateEvent();
    expect(h.deps.execute).not.toHaveBeenCalled();
  });

  it.each(["approval", "executing", "graphRouting"] as const)("defers a reply during %s unwind and resumes it once in Testing", async (owner) => {
    const h = fixture();
    await h.runGraph();
    await h.reply();
    if (owner === "approval") h.deps.approvalSuspended.add(h.row.id);
    const busy = owner === "graphRouting" ? h.deps.graphRouting : h.deps.executing;
    busy.add(h.row.id);
    await h.updateEvent();
    expect(h.deps.approvalResumeAfterUnwind.has(h.row.id)).toBe(true);
    busy.delete(h.row.id);
    await resumeApprovalAfterUnwindIfNeeded(h.deps as never, h.row.id);
    expect(h.deps.execute).toHaveBeenCalledOnce();
    await h.deps.execute.mock.results[0].value;
    expect(h.row.column).toBe("done");
  });

  it("coalesces duplicate reply events into one graph run", async () => {
    const h = fixture();
    await h.runGraph();
    await h.reply();
    await Promise.all([h.updateEvent(), h.updateEvent(), h.updateEvent()]);
    expect(h.deps.execute).toHaveBeenCalledOnce();
    await h.deps.execute.mock.results[0].value;
    expect(h.row.column).toBe("done");
  });

  it("reads a fresh workflow membership snapshot after a definition change", async () => {
    const h = fixture();
    await expect(h.deps.resolveResumeLanes(h.row.id)).resolves.toMatchObject({ wipColumns: columns });
    h.ir.columns!.find((column) => column.id === "testing")!.traits = [];
    await expect(h.deps.resolveResumeLanes(h.row.id)).resolves.toMatchObject({ wipColumns: ["coding", "review"] });
  });
});
