import type { WorkflowIrV2 } from "./workflow-ir-types.js";
import { validateCustomFieldPatch } from "../tasks/task-fields.js";

/** FNXC:ProblemReporting 2026-09-11-11:22:
 * Testing workflows explicitly grant reporting only from named columns. Reports remain
 * human-owned and require a structured results ledger, including an explicit empty ledger.
 * Validate capabilities during import and again before testing spends any model budget.
 */
export function validateProblemReportingPolicy(ir: WorkflowIrV2): void {
  const policy = ir.problemReporting;
  if (policy === undefined) return;
  if (!policy || !Array.isArray(policy.sourceColumns) || !policy.sourceColumns.length ||
      typeof policy.openColumn !== "string" || typeof policy.resolvedColumn !== "string" ||
      policy.openColumn === policy.resolvedColumn) {
    throw new Error("Invalid problemReporting policy");
  }
  for (const id of [...policy.sourceColumns, policy.openColumn, policy.resolvedColumn]) {
    if (typeof id !== "string" || !ir.columns.some((column) => column.id === id)) {
      throw new Error(`problemReporting references unknown column: ${id}`);
    }
  }
  if (policy.sourceColumns.some((id) => id === policy.openColumn || id === policy.resolvedColumn)) {
    throw new Error("Problem columns cannot authorize reporting sessions");
  }
  // FNXC:ProblemReporting 2026-09-11-12:09: Reject unsafe dictionary keys and invalid defaults at import, before a reporting stage spends its model budget.
  for (const field of ir.fields ?? []) {
    if (["__proto__", "constructor", "prototype"].includes(field.id)) throw new Error(`problemReporting reserves field id: ${field.id}`);
    if (field.default !== undefined) {
      const checked = validateCustomFieldPatch(ir.fields, { [field.id]: field.default });
      if (!checked.ok || (field.required && field.default === null)) throw new Error(`problemReporting field ${field.id} has an invalid default`);
    }
  }
  for (const id of ["record_type", "problem_type", "kit_path", "extension_path", "originating_task_id"]) {
    const field = ir.fields?.find((entry) => entry.id === id);
    if (!field || !["string", "text", "enum"].includes(field.type)) {
      throw new Error(`problemReporting requires a declared string/text/enum field: ${id}`);
    }
    const values = id === "record_type" ? ["problem"] : id === "problem_type" ? ["general", "parity"] : [];
    if (field.type === "enum" && (values.length === 0 || values.some((value) => !field.options?.some((option) => option.value === value)))) {
      throw new Error(`problemReporting field ${id} does not accept required values`);
    }
  }
}
