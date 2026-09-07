import { RETIRED_BUILTIN_WORKFLOW_SUCCESSORS } from "../types.js";
import type { WorkflowDefinition } from "./workflow-definition-types.js";
import type { WorkflowIr } from "./workflow-ir-types.js";

/* FNXC:CustomWorkflows 2026-09-07-01:09: This fork ships no workflow catalog. The old id namespace is retained only for reading project-owned historical definitions. */
export const BUILTIN_WORKFLOW_ID_PREFIX = "builtin:";
export const BUILTIN_WORKFLOWS: WorkflowDefinition[] = [];
export const DEFAULT_WORKFLOW_ID = "";
export function isBuiltinWorkflowId(id: string): boolean { return id.startsWith(BUILTIN_WORKFLOW_ID_PREFIX); }
export function resolveRetiredBuiltinWorkflowId(id: string): string { return RETIRED_BUILTIN_WORKFLOW_SUCCESSORS.get(id) ?? id; }
export function getBuiltinWorkflow(_id: string): WorkflowDefinition | undefined { return undefined; }
export function isBuiltinWorkflowPluginGated(_id: string): boolean { return false; }
export function getRequiredPluginIdForBuiltinWorkflow(_id: string): string | undefined { return undefined; }
export function isBuiltinWorkflowDeprecated(id: string): boolean { return isBuiltinWorkflowId(id); }
export function isBuiltinWorkflowToggleEligible(_id: string): boolean { return false; }
export function toggleEligibleBuiltinWorkflowIds(): string[] { return []; }
export function defaultEnabledBuiltinWorkflowIds(): string[] { return []; }
export function effectiveEnabledBuiltinWorkflowIds(_enabledIds?: readonly string[]): string[] { return []; }
export function isBuiltinWorkflowEnabled(id: string, _enabledIds?: readonly string[]): boolean { return !isBuiltinWorkflowId(id); }

/* FNXC:CustomWorkflows 2026-09-07-01:09: Accept old persisted settings without making them executable or blocking unrelated settings saves. No setting can restore removed templates. */
export function validateEnabledBuiltinWorkflowIds(value: unknown): asserts value is string[] | null | undefined {
  if (value == null) return;
  if (!Array.isArray(value) || value.some(id => typeof id !== "string") || new Set(value).size !== value.length) {
    throw new Error("enabledBuiltinWorkflowIds must be an array of distinct strings or null");
  }
}
export function resolveEffectiveDefaultWorkflowId(configuredWorkflowId?: string | null, _enabledIds?: readonly string[]): string {
  const id = configuredWorkflowId?.trim();
  return id && !isBuiltinWorkflowId(id) ? id : "";
}

/* FNXC:CustomWorkflows 2026-09-07-01:09: A missing definition has no executable graph. This empty read model keeps empty projects and historical diagnostics readable without inventing a workflow or dispatching work. */
export function resolveDefaultWorkflowIr(): WorkflowIr {
  return { version: "v2", name: "No workflow", columns: [], nodes: [], edges: [] };
}
