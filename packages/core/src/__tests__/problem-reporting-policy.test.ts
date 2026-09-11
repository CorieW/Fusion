import { describe, expect, it } from "vitest";
import { validateProblemReportingPolicy } from "../workflows/problem-reporting-policy.js";
import { parseWorkflowIr, downgradeIrToV1IfPure } from "../workflows/workflow-ir.js";
import type { WorkflowIrV2 } from "../workflows/workflow-ir-types.js";

const workflow = (): WorkflowIrV2 => ({
  version: "v2", name: "Testing", columns: ["testing", "problems", "resolved-problems"].map((id) => ({ id, name: id, traits: [] })),
  nodes: [{ id: "start", kind: "start", column: "testing" }, { id: "end", kind: "end", column: "testing" }], edges: [{ from: "start", to: "end" }],
  fields: ["record_type", "problem_type", "kit_path", "extension_path", "originating_task_id"].map((id) => ({ id, name: id, type: "text" })),
  problemReporting: { sourceColumns: ["testing"], openColumn: "problems", resolvedColumn: "resolved-problems" },
});
describe("problem reporting import capability validation", () => {
  it("round trips explicit authority and leaves ordinary workflows unchanged", () => {
    const ir = workflow();
    expect(parseWorkflowIr(JSON.stringify(ir))).toEqual(ir);
    expect(downgradeIrToV1IfPure(ir)).toEqual(ir);
    delete ir.problemReporting;
    expect(() => validateProblemReportingPolicy(ir)).not.toThrow();
  });
  it.each(["record_type", "problem_type", "kit_path", "extension_path", "originating_task_id"])("rejects missing %s before testing starts", (id) => {
    const ir = workflow();
    ir.fields = ir.fields!.filter((field) => field.id !== id);
    expect(() => parseWorkflowIr(ir)).toThrow(id);
  });
  it("rejects unknown, overlapping and empty authorized columns", () => {
    for (const patch of [{ sourceColumns: [] }, { openColumn: "missing" }, { sourceColumns: ["problems"] }, { resolvedColumn: "problems" }]) {
      const ir = workflow();
      Object.assign(ir.problemReporting!, patch);
      expect(() => parseWorkflowIr(ir)).toThrow();
    }
  });
  it("rejects incompatible field schemas", () => {
    const ir = workflow();
    ir.fields![1] = { id: "problem_type", name: "Type", type: "enum", options: [{ value: "general", label: "General" }] };
    expect(() => parseWorkflowIr(ir)).toThrow("required values");
  });
  it.each([
    { id: "__proto__", type: "text" as const },
    { id: "constructor", type: "text" as const },
    { id: "prototype", type: "text" as const },
    { id: "invalid_default", type: "number" as const, default: "not a number" },
    { id: "null_required", type: "text" as const, required: true, default: null },
  ])("rejects unusable custom field $id before testing starts", (field) => {
    const ir = workflow();
    ir.fields!.push({ name: field.id, ...field });
    expect(() => parseWorkflowIr(ir)).toThrow(field.id);
  });
});
