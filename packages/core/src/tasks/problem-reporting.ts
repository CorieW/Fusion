import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { TaskStore } from "../store.js";
import type { DbTransaction } from "../postgres/data-layer.js";
import { tasks, taskWorkflowSelection, workflows } from "../postgres/schema/project.js";
import { parseWorkflowIr } from "../workflows/workflow-ir.js";
import type { WorkflowIrV2 } from "../workflows/workflow-ir-types.js";
import { validateCustomFieldPatch } from "./task-fields.js";
import { softDeleteTaskRowInTransaction } from "../task-store/async/async-persistence.js";
import { appendTaskLifecycleEventInTransaction } from "../task-store/lifecycle-outbox.js";

export interface ProblemReportInput {
  requestId: string;
  problemKey: string;
  problemType: "general" | "parity";
  title: string;
  kitPath: string;
  extensionPath: string;
  reproduction: string;
  configuration: string;
  evidence: string[];
  extensionObservation?: string;
  kitObservation?: string;
  customFields?: Record<string, unknown>;
}
export interface ProblemReportReceipt {
  createdTaskId: string;
  survivingTaskId: string;
  matchedResolvedTaskId: string | null;
  deletedTaskIds: string[];
}
type Row = typeof tasks.$inferSelect;
type Observation = { taskId: string; input: ProblemReportInput; customFields: Record<string, unknown>; retainedRecord?: Pick<Row, "title" | "description" | "customFields" | "comments" | "attachments"> };
type Problem = {
  key: string;
  inputHash: string;
  observations: Observation[];
  receipt: ProblemReportReceipt;
  supersededBy?: string;
};
interface Ledger {
  sessionId: string;
  workflowId: string;
  sourceColumn: string;
  sourceNodeId: string | null;
  stageId: string;
  expected: string[];
  receipts: Record<string, ProblemReportReceipt>;
  finished: boolean;
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const metadata = (row: Row) => object(row.sourceMetadata);
const problem = (row: Row) => metadata(row).problemReport as Problem | undefined;
const hash = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(object(value)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function reportDescription(observations: Observation[]): string {
  return observations.map(({ input, retainedRecord }, index) => [
    index ? `## Retained finding: ${input.title}` : `## ${input.title}`,
    `Type: ${input.problemType}\nKit: ${input.kitPath}\nExtension: ${input.extensionPath}`,
    `### Reproduction\n${input.reproduction}`,
    `### Configuration\n${input.configuration}`,
    `### Evidence\n${input.evidence.map((entry) => `- ${entry}`).join("\n")}`,
    ...(input.problemType === "parity" ? [`### Paired observations\nExtension: ${input.extensionObservation}\nKit: ${input.kitObservation}`] : []),
    ...(retainedRecord?.description ? [`### Previous record\n${retainedRecord.description}`] : []),
  ].join("\n\n")).join("\n\n");
}

/** FNXC:ProblemReporting 2026-09-11-11:22:
 * A problem key identifies the demonstrated underlying defect, never a fuzzy title match.
 * Type and paired paths are part of identity. Resolved records are immutable. Open duplicates
 * retain the newest report and every older observation (including conflicting custom values).
 * Report rows, workflow membership, receipt and deletions commit together under a project/workflow
 * advisory lock. Deterministic request IDs make lost-response retries safe across processes.
 */
async function policyFor(store: TaskStore, sourceTaskId: string): Promise<{ workflowId: string; ir: WorkflowIrV2 } | undefined> {
  if (typeof store.getTaskWorkflowSelectionAsync !== "function") return undefined;
  const selection = await store.getTaskWorkflowSelectionAsync(sourceTaskId);
  if (!selection) return undefined;
  const definition = await store.getWorkflowDefinition(selection.workflowId);
  if (!definition) return undefined;
  const ir = parseWorkflowIr(definition.ir);
  if (ir.version !== "v2" || !ir.problemReporting) return undefined;
  return { workflowId: selection.workflowId, ir };
}

export async function problemReportingPreflight(store: TaskStore, sourceTaskId: string, sessionId?: string) {
  const selected = await policyFor(store, sourceTaskId);
  if (!selected) return { available: false as const, reason: "Workflow has not authorized problem reporting" };
  const parent = await store.getTask(sourceTaskId);
  if (!selected.ir.problemReporting!.sourceColumns.includes(parent.column)) {
    return { available: false as const, reason: "Current column has not authorized problem reporting" };
  }
  if (!store.asyncLayer?.projectId) throw new Error("Problem reporting requires project-scoped PostgreSQL storage");
  if (sessionId) await authorized(store, sourceTaskId, async ({ parent, workflowId }) => { ledgerFor(parent, sessionId, workflowId); });
  const policy = selected.ir.problemReporting!;
  return { available: true as const, workflowId: selected.workflowId, sourceColumns: policy.sourceColumns, openColumn: policy.openColumn, resolvedColumn: policy.resolvedColumn };
}

async function authorized<T>(store: TaskStore, sourceTaskId: string, fn: (ctx: {
  tx: DbTransaction; parent: Row; projectId: string; workflowId: string; ir: WorkflowIrV2;
}) => Promise<T>): Promise<T> {
  const selected = await policyFor(store, sourceTaskId);
  const layer = store.asyncLayer;
  if (!selected || !layer?.projectId) throw new Error("Problem reporting is not authorized for this session");
  const projectId = layer.projectId;
  return layer.transactionImmediate(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`problem-report:${projectId}:${selected.workflowId}`}, 0))`);
    const [definition] = await tx.select().from(workflows).where(and(eq(workflows.projectId, projectId), eq(workflows.id, selected.workflowId))).for("share");
    const ir = definition ? parseWorkflowIr(definition.ir as WorkflowIrV2) : undefined;
    const [parent] = await tx.select().from(tasks).where(and(eq(tasks.projectId, projectId), eq(tasks.id, sourceTaskId), isNull(tasks.deletedAt))).for("update");
    const [selection] = await tx.select().from(taskWorkflowSelection).where(and(eq(taskWorkflowSelection.projectId, projectId), eq(taskWorkflowSelection.taskId, sourceTaskId))).for("share");
    if (!parent || selection?.workflowId !== selected.workflowId || ir?.version !== "v2" || !ir.problemReporting?.sourceColumns.includes(parent.column)) {
      throw new Error("Problem reporting source task/workflow/column is no longer authorized");
    }
    return fn({ tx, parent, projectId, workflowId: selected.workflowId, ir });
  });
}

function ledgerFor(parent: Row, sessionId?: string, workflowId?: string): Ledger {
  const ledger = metadata(parent).problemReportingLedger as Ledger | undefined;
  if (!ledger || (sessionId && ledger.sessionId !== sessionId) || ledger.sourceColumn !== parent.column || ledger.sourceNodeId !== (parent.effectiveNodeId ?? parent.nodeId) || (workflowId && ledger.workflowId !== workflowId)) throw new Error("No active problem-reporting session; run workflow preflight first");
  return ledger;
}
async function saveLedger(tx: DbTransaction, parent: Row, ledger: Ledger) {
  await tx.update(tasks).set({ sourceMetadata: { ...metadata(parent), problemReportingLedger: ledger }, updatedAt: new Date().toISOString() })
    .where(and(eq(tasks.projectId, parent.projectId), eq(tasks.id, parent.id)));
}

export async function beginProblemReportingSession(store: TaskStore, sourceTaskId: string, stageId?: string): Promise<string | undefined> {
  const preflight = await problemReportingPreflight(store, sourceTaskId);
  if (!preflight.available) return undefined;
  return authorized(store, sourceTaskId, async ({ tx, parent, workflowId }) => {
    const sessionId = randomUUID();
    const scope = stageId ?? parent.effectiveNodeId ?? parent.nodeId ?? parent.column;
    const previous = metadata(parent).problemReportingLedger as Ledger | undefined;
    const inherited = previous?.stageId === scope && previous.workflowId === workflowId ? previous : undefined;
    // FNXC:ProblemReporting 2026-09-11-11:22: A retry cannot erase unresolved mandatory findings or committed receipts from its stage.
    await saveLedger(tx, parent, { sessionId, workflowId, sourceColumn: parent.column, sourceNodeId: parent.effectiveNodeId ?? parent.nodeId, stageId: scope, expected: inherited?.expected ?? [], receipts: inherited?.receipts ?? {}, finished: false });
    return sessionId;
  });
}

async function surviving(tx: DbTransaction, projectId: string, taskId: string, workflowId: string, columns: string[]): Promise<Row> {
  const seen = new Set<string>();
  while (!seen.has(taskId)) {
    seen.add(taskId);
    const [row] = await tx.select().from(tasks).where(and(eq(tasks.projectId, projectId), eq(tasks.id, taskId)));
    if (!row) break;
    if (!row.deletedAt) {
      const [selection] = await tx.select().from(taskWorkflowSelection).where(and(eq(taskWorkflowSelection.projectId, projectId), eq(taskWorkflowSelection.taskId, row.id)));
      if (selection?.workflowId === workflowId && columns.includes(row.column)) return row;
      break;
    }
    const next = problem(row)?.supersededBy;
    if (!next) break;
    taskId = next;
  }
  throw new Error(`Mandatory problem record has no live survivor: ${taskId}`);
}

export async function updateProblemReportingLedger(store: TaskStore, sourceTaskId: string, requestIds: string[], finish: boolean, sessionId?: string) {
  if (requestIds.some((id) => typeof id !== "string" || !id.trim() || ["__proto__", "constructor", "prototype"].includes(id)) || new Set(requestIds).size !== requestIds.length) throw new Error("Ledger request IDs must be nonempty, safe and unique");
  return authorized(store, sourceTaskId, async ({ tx, parent, projectId, workflowId, ir }) => {
    const ledger = ledgerFor(parent, sessionId, workflowId);
    ledger.expected = [...new Set([...ledger.expected, ...requestIds])];
    ledger.finished = false;
    if (finish) {
      if (ledger.expected.some((id) => !requestIds.includes(id)) || Object.keys(ledger.receipts).some((id) => !requestIds.includes(id))) throw new Error("Final ledger must include every expected and reported finding");
      for (const id of ledger.expected) {
        const receipt = Object.hasOwn(ledger.receipts, id) ? ledger.receipts[id] : undefined;
        if (!receipt) throw new Error(`Missing mandatory problem report: ${id}`);
        const row = await surviving(tx, projectId, receipt.survivingTaskId, workflowId, [ir.problemReporting!.openColumn, ir.problemReporting!.resolvedColumn]);
        receipt.survivingTaskId = row.id;
        receipt.matchedResolvedTaskId = row.column === ir.problemReporting!.resolvedColumn ? row.id : null;
      }
      ledger.finished = true;
    }
    await saveLedger(tx, parent, ledger);
    return ledger;
  });
}

export async function assertProblemReportingComplete(store: TaskStore, sourceTaskId: string, sessionId?: string): Promise<void> {
  if (!sessionId && !(await problemReportingPreflight(store, sourceTaskId)).available) return;
  await authorized(store, sourceTaskId, async ({ tx, parent, projectId, workflowId, ir }) => {
    const ledger = ledgerFor(parent, sessionId, workflowId);
    if (!ledger.finished) throw new Error("Problem reporting stage cannot succeed before fn_problem_report(action=finish) verifies its mandatory results ledger");
    for (const id of ledger.expected) {
      const receipt = Object.hasOwn(ledger.receipts, id) ? ledger.receipts[id] : undefined;
      if (!receipt) throw new Error(`Missing mandatory problem report: ${id}`);
      await surviving(tx, projectId, receipt.survivingTaskId, workflowId, [ir.problemReporting!.openColumn, ir.problemReporting!.resolvedColumn]);
    }
  });
}

export async function reportProblem(store: TaskStore, sourceTaskId: string, input: ProblemReportInput, sessionId?: string): Promise<ProblemReportReceipt> {
  for (const key of ["requestId", "problemKey", "title", "kitPath", "extensionPath", "reproduction", "configuration"] as const) {
    if (typeof input[key] !== "string" || !input[key].trim()) throw new Error(`Problem report requires ${key}`);
  }
  if (["__proto__", "constructor", "prototype"].includes(input.requestId)) throw new Error("Unsafe requestId");
  if (!["general", "parity"].includes(input.problemType) || !Array.isArray(input.evidence) || !input.evidence.length || input.evidence.some((value) => typeof value !== "string" || !value.trim())) throw new Error("Problem report requires type and demonstrated evidence");
  if (input.problemType === "parity" && (!input.extensionObservation?.trim() || !input.kitObservation?.trim())) throw new Error("Parity reports require paired extension and kit observations");
  let created = false;
  const receipt = await authorized(store, sourceTaskId, async ({ tx, parent, projectId, workflowId, ir }) => {
    const ledger = ledgerFor(parent, sessionId, workflowId);
    const policy = ir.problemReporting!;
    const id = `PRB-${hash([projectId, workflowId, sourceTaskId, input.requestId]).slice(0, 24)}`;
    const inputHash = hash(input);
    const key = hash([input.problemKey.trim(), input.problemType, input.kitPath.trim(), input.extensionPath.trim()]);
    const columns = [policy.openColumn, policy.resolvedColumn];
    const [prior] = await tx.select().from(tasks).where(and(eq(tasks.projectId, projectId), eq(tasks.id, id)));
    if (prior) {
      const saved = problem(prior);
      if (!saved || saved.inputHash !== inputHash) throw new Error("requestId was already used for different evidence; use a new requestId");
      const row = await surviving(tx, projectId, id, workflowId, columns);
      const receipt = { ...saved.receipt, survivingTaskId: row.id, matchedResolvedTaskId: row.column === policy.resolvedColumn ? row.id : null };
      ledger.receipts[input.requestId] = receipt;
      ledger.finished = false;
      await saveLedger(tx, parent, ledger);
      return receipt;
    }
    // FNXC:ProblemReporting 2026-09-11-12:09: An identical committed retry returns its receipt even after optional workflow fields change.
    const fields: Record<string, unknown> = { ...input.customFields, record_type: "problem", problem_type: input.problemType, kit_path: input.kitPath, extension_path: input.extensionPath, originating_task_id: sourceTaskId };
    const checked = validateCustomFieldPatch(ir.fields ?? [], fields);
    if (!checked.ok) throw new Error(checked.rejection.detail);
    const candidates = await tx.select({ task: tasks }).from(tasks).innerJoin(taskWorkflowSelection, and(eq(taskWorkflowSelection.projectId, tasks.projectId), eq(taskWorkflowSelection.taskId, tasks.id)))
      .where(and(eq(tasks.projectId, projectId), eq(taskWorkflowSelection.workflowId, workflowId), isNull(tasks.deletedAt), inArray(tasks.column, columns))).for("update");
    const matches = candidates.map(({ task }) => task).filter((row) => {
      const values = object(row.customFields);
      return problem(row)?.key === key && values.record_type === "problem" && values.problem_type === input.problemType &&
        typeof values.kit_path === "string" && values.kit_path.trim() === input.kitPath.trim() &&
        typeof values.extension_path === "string" && values.extension_path.trim() === input.extensionPath.trim();
    });
    const resolved = matches.filter((row) => row.column === policy.resolvedColumn).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
    const open = matches.filter((row) => row.column === policy.openColumn);
    const now = new Date().toISOString();
    const receipt: ProblemReportReceipt = { createdTaskId: id, survivingTaskId: resolved?.id ?? id, matchedResolvedTaskId: resolved?.id ?? null, deletedTaskIds: resolved ? [id] : open.map((row) => row.id) };
    const observations: Observation[] = [{ taskId: id, input, customFields: checked.normalized }];
    if (!resolved) {
      for (const row of open) {
        observations.push(...(problem(row)?.observations ?? []).map((observation) => observation.taskId === row.id
          ? { ...observation, retainedRecord: { title: row.title, description: row.description === reportDescription(problem(row)!.observations) ? "" : row.description, customFields: row.customFields, comments: row.comments, attachments: row.attachments } }
          : observation));
        for (const [field, value] of Object.entries(object(row.customFields))) {
          if ((!Object.hasOwn(checked.normalized, field) || checked.normalized[field] == null) && value != null && validateCustomFieldPatch(ir.fields ?? [], { [field]: value }).ok) checked.normalized[field] = value;
        }
      }
    }
    // FNXC:ProblemReporting 2026-09-11-12:09: Merge retained values before defaults, then require real values; a null patch cannot bypass required fields with defaults.
    for (const field of ir.fields ?? []) {
      if ((!Object.hasOwn(checked.normalized, field.id) || checked.normalized[field.id] == null) && field.default !== undefined) checked.normalized[field.id] = field.default;
      if (field.required && (!Object.hasOwn(checked.normalized, field.id) || checked.normalized[field.id] == null)) throw new Error(`Missing required custom field: ${field.id}`);
    }
    const finalizedFields = validateCustomFieldPatch(ir.fields ?? [], checked.normalized);
    if (!finalizedFields.ok) throw new Error(finalizedFields.rejection.detail);
    const report: Problem = { key, inputHash, observations: [...new Map(observations.map((item) => [item.taskId, item])).values()], receipt, ...(resolved ? { supersededBy: resolved.id } : {}) };
    await tx.insert(tasks).values({ id, projectId, title: input.title, description: reportDescription(report.observations), column: policy.openColumn, createdAt: now, updatedAt: now,
      paused: 1, userPaused: 1, pausedReason: "Problem report awaiting human review", autoMerge: 0,
      customFields: checked.normalized, sourceParentTaskId: sourceTaskId, sourceType: "api", sourceMetadata: { problemReport: report } });
    await tx.insert(taskWorkflowSelection).values({ projectId, taskId: id, workflowId, stepIds: [], updatedAt: now });
    for (const deletedId of receipt.deletedTaskIds) {
      const row = open.find((entry) => entry.id === deletedId);
      if (row) await tx.update(tasks).set({ sourceMetadata: { ...metadata(row), problemReport: { ...problem(row), supersededBy: id } } }).where(and(eq(tasks.projectId, projectId), eq(tasks.id, deletedId)));
      await softDeleteTaskRowInTransaction(tx, deletedId, now, false, projectId, true);
      await appendTaskLifecycleEventInTransaction(tx, { projectId, eventType: "task:deleted", taskId: deletedId, occurredAt: now,
        payload: { taskId: deletedId, previousColumn: policy.openColumn, previousStatus: row?.status ?? null, deletedAt: now, allowResurrection: false, githubIssueAction: null, deletedBy: parent.assignedAgentId } });
    }
    ledger.receipts[input.requestId] = receipt;
    ledger.finished = false;
    await saveLedger(tx, parent, ledger);
    await store.recordRunAuditEventBackend(tx, { domain: "database", mutationType: "task:problem-reported", target: id, taskId: sourceTaskId,
      agentId: parent.assignedAgentId ?? "workflow", runId: ledger.sessionId,
      metadata: { createdTaskId: id, survivingTaskId: receipt.survivingTaskId, matchedResolvedTaskId: receipt.matchedResolvedTaskId, deletedTaskIds: receipt.deletedTaskIds } });
    created = true;
    return receipt;
  });
  if (created && !receipt.matchedResolvedTaskId) {
    try {
      const task = await store.getTask(receipt.survivingTaskId);
      store.emitTaskLifecycleEventSafely("task:created", [task]);
    } catch {
      // FNXC:ProblemReporting 2026-09-11-11:22: Notification/readback failure cannot undo a committed receipt; the next report may already have superseded this task.
    }
  }
  return receipt;
}

export async function readProblemReports(store: TaskStore, sourceTaskId: string, options: { column?: string; after?: string; id?: string; observationOffset?: number; contentOffset?: number; contentHash?: string } = {}, sessionId?: string) {
  return authorized(store, sourceTaskId, async ({ tx, parent, projectId, workflowId, ir }) => {
    if (sessionId) ledgerFor(parent, sessionId, workflowId);
    const columns = [ir.problemReporting!.openColumn, ir.problemReporting!.resolvedColumn];
    if (options.column && !columns.includes(options.column)) throw new Error("Column is outside the problem-reporting capability");
    if (options.id) {
      const row = await surviving(tx, projectId, options.id, workflowId, columns);
      const observations = problem(row)?.observations ?? [];
      const offset = Math.max(0, Math.floor(options.observationOffset ?? 0));
      const currentRecord = { title: row.title, description: row.description === reportDescription(observations) ? "" : row.description, comments: row.comments, attachments: row.attachments };
      const result = { id: row.id, column: row.column, customFields: row.customFields, currentRecord, observations: observations.slice(offset, offset + 1), nextObservationOffset: offset + 1 < observations.length ? offset + 1 : null };
      const content = JSON.stringify(result);
      if (content.length <= 8_000 && options.contentOffset === undefined) return result;
      const contentHash = hash(content);
      if (options.contentHash && options.contentHash !== contentHash) throw new Error("Problem evidence changed during paging; restart this read");
      const start = Math.max(0, Math.floor(options.contentOffset ?? 0));
      let size = 4_000;
      const page = () => ({ id: row.id, contentPart: content.slice(start, start + size), contentHash, nextContentOffset: start + size < content.length ? start + size : null, nextObservationOffset: result.nextObservationOffset });
      // FNXC:ProblemReporting 2026-09-11-12:09: Budget serialized JSON, including escape expansion, so evidence and continuation cursors survive provider output clamps.
      while (JSON.stringify(page()).length > 8_000 && size > 1) size = Math.floor(size / 2);
      return page();
    }
    const rows = await tx.select({ id: tasks.id, title: tasks.title, column: tasks.column }).from(tasks).innerJoin(taskWorkflowSelection, and(eq(taskWorkflowSelection.projectId, tasks.projectId), eq(taskWorkflowSelection.taskId, tasks.id)))
      .where(and(eq(tasks.projectId, projectId), eq(taskWorkflowSelection.workflowId, workflowId), isNull(tasks.deletedAt), inArray(tasks.column, options.column ? [options.column] : columns)));
    const remaining = rows.sort((a, b) => a.id.localeCompare(b.id)).filter((row) => !options.after || row.id.localeCompare(options.after) > 0);
    const page = remaining.slice(0, 25).map((row) => ({ ...row, title: row.title?.slice(0, 100) ?? null }));
    while (JSON.stringify({ tasks: page, nextCursor: page.at(-1)?.id }).length > 8_000 && page.length > 1) page.pop();
    return { tasks: page, nextCursor: remaining.length > page.length ? page.at(-1)!.id : null };
  });
}
