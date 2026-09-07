import { describe, expect, it } from "vitest";
import { resolveDefaultWorkflowIr } from "../workflows/builtin-workflows.js";
import { resolveEntryColumnId } from "../workflows/workflow-reconciliation.js";
describe("workflow deletion without bundled fallbacks", () => {
  it("has no implicit replacement entry column for orphaned tasks", () => {
    expect(resolveEntryColumnId(resolveDefaultWorkflowIr())).toBeUndefined();
  });
});
