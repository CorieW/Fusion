import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { problemReportingPreflight, reportProblem, readProblemReports, updateProblemReportingLedger, type ProblemReportInput, type TaskStore } from "@fusion/core";

export const problemReportParameters = Type.Object({
  action: Type.Union(["preflight", "expect", "report", "list", "read", "finish"].map((value) => Type.Literal(value))),
  requestIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  report: Type.Optional(Type.Object({
    requestId: Type.String({ minLength: 1 }),
    problemKey: Type.String({ minLength: 1, description: "Stable identity of the underlying demonstrated defect. Reuse for duplicates; never use a generic category or title." }),
    problemType: Type.Union([Type.Literal("general"), Type.Literal("parity")]),
    title: Type.String({ minLength: 1 }),
    kitPath: Type.String({ minLength: 1 }),
    extensionPath: Type.String({ minLength: 1 }),
    reproduction: Type.String({ minLength: 1 }),
    configuration: Type.String({ minLength: 1 }),
    evidence: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    extensionObservation: Type.Optional(Type.String()),
    kitObservation: Type.Optional(Type.String()),
    customFields: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  })),
  column: Type.Optional(Type.String()),
  after: Type.Optional(Type.String()),
  id: Type.Optional(Type.String()),
  observationOffset: Type.Optional(Type.Integer({ minimum: 0 })),
  contentOffset: Type.Optional(Type.Integer({ minimum: 0 })),
  contentHash: Type.Optional(Type.String()),
});

export interface ProblemToolParams {
  action: string; requestIds?: string[]; report?: ProblemReportInput;
  column?: string; after?: string; id?: string; observationOffset?: number; contentOffset?: number; contentHash?: string;
}

const reportingTools = new WeakSet<ToolDefinition>();
export const isProblemReportTool = (tool: ToolDefinition): boolean => reportingTools.has(tool);

/** FNXC:ProblemReporting 2026-09-11-11:22:
 * Engine and CLI expose one schema and implementation. The source task is trusted session
 * context, never model input. This capability cannot create arbitrary work or target another
 * project/workflow. Preflight is readable even when reporting is unavailable.
 */
export function createProblemReportTool(store: TaskStore, sourceTaskId: string, sessionId?: string): ToolDefinition {
  const tool: ToolDefinition = {
    name: "fn_problem_report",
    label: "Report Workflow Problems",
    description: "Authorized structured problem reporting. Run preflight before testing. Declare mandatory finding requestIds with expect, then report each demonstrated defect. Reuse requestId only for identical retries; use a new requestId for new evidence and the same problemKey for the same underlying defect. General/parity and paired paths are distinct. Resolved matches win; otherwise newest wins with older evidence preserved. list pages both designated columns using after/nextCursor; read pages observations using observationOffset/nextObservationOffset. Large reads return contentPart: follow nextContentOffset with contentHash and concatenate parts as JSON. Finish with ALL finding requestIds (explicit [] for no findings). Missing reports or finish prevent stage success. Records stay parked for humans.",
    parameters: problemReportParameters,
    execute: async (_id: string, params: ProblemToolParams) => {
      try {
        let result: unknown;
        // FNXC:ProblemReporting 2026-09-11-12:09: The CLI bridge must carry the engine generation, never adopt whichever ledger is current at call time.
        if (params.action !== "preflight" && !sessionId) throw new Error("No authorized problem-reporting session generation");
        switch (params.action) {
          case "preflight": {
            const preflight = await problemReportingPreflight(store, sourceTaskId, sessionId);
            result = preflight.available && !sessionId ? { available: false, reason: "No authorized problem-reporting session generation" } : preflight;
            break;
          }
          case "report":
            if (!params.report) throw new Error("report is required");
            // FNXC:ProblemReporting 2026-09-11-11:22: A rejected write remains a mandatory pending finding and invalidates any earlier finish.
            await updateProblemReportingLedger(store, sourceTaskId, [params.report.requestId], false, sessionId);
            result = await reportProblem(store, sourceTaskId, params.report, sessionId); break;
          case "list": result = await readProblemReports(store, sourceTaskId, { column: params.column, after: params.after }, sessionId); break;
          case "read":
            if (!params.id) throw new Error("id is required");
            result = await readProblemReports(store, sourceTaskId, { id: params.id, observationOffset: params.observationOffset, ...(params.contentOffset !== undefined ? { contentOffset: params.contentOffset } : {}), ...(params.contentHash ? { contentHash: params.contentHash } : {}) }, sessionId); break;
          case "expect": case "finish":
            if (!params.requestIds) throw new Error("requestIds is required; use [] for no findings");
            result = await updateProblemReportingLedger(store, sourceTaskId, params.requestIds, params.action === "finish", sessionId); break;
          default: throw new Error("Unknown problem-reporting action");
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text" as const, text: message }], details: { error: message }, isError: true };
      }
    },
  };
  reportingTools.add(tool);
  return tool;
}
