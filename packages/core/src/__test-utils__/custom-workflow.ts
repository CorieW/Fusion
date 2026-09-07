import type { TaskStore } from "../store.js";
import { BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR } from "./legacy-workflows/builtin-stepwise-final-review-coding-workflow-ir.js";

/* FNXC:CustomWorkflows 2026-09-07-01:09: Lifecycle tests explicitly author their workflow. Fresh stores stay empty; this helper is never called by production initialization. */
export async function installTestWorkflow(store: TaskStore): Promise<void> {
  const workflow = await store.createWorkflowDefinition({ name: "Test lifecycle", ir: structuredClone(BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR) });
  await store.setDefaultWorkflowId(workflow.id);
}
