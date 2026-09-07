import * as schema from "../postgres/schema/index.js";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { BUILTIN_WORKFLOWS, getBuiltinWorkflow, defaultEnabledBuiltinWorkflowIds, effectiveEnabledBuiltinWorkflowIds, resolveEffectiveDefaultWorkflowId, resolveDefaultWorkflowIr } from "../workflows/builtin-workflows.js";
import { resolveWorkflowIrById } from "../workflows/workflow-ir-resolver.js";
import { pgDescribe, createSharedPgTaskStoreTestHarness } from "../__test-utils__/pg-test-harness.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "../__test-utils__/legacy-workflows/builtin-coding-workflow-ir.js";

describe("projects without bundled workflows", () => {
  it("has no catalog or implicit default, including with old enablement settings", () => {
    expect(BUILTIN_WORKFLOWS).toEqual([]);
    expect(getBuiltinWorkflow("builtin:coding")).toBeUndefined();
    expect(defaultEnabledBuiltinWorkflowIds()).toEqual([]);
    expect(effectiveEnabledBuiltinWorkflowIds(["builtin:coding"])).toEqual([]);
    expect(resolveEffectiveDefaultWorkflowId()).toBe("");
    expect(resolveEffectiveDefaultWorkflowId("builtin:coding", ["builtin:coding"])).toBe("");
    expect(resolveEffectiveDefaultWorkflowId("WF-001")).toBe("WF-001");
  });
  it("resolves historical definitions from project data without substituting a bundled graph", async () => {
    const store = { getWorkflowDefinition: async (id: string) => id === "builtin:coding" ? { ir: BUILTIN_CODING_WORKFLOW_IR } : undefined };
    expect(await resolveWorkflowIrById(store, "builtin:coding")).toEqual(BUILTIN_CODING_WORKFLOW_IR);
    const missing = await resolveWorkflowIrById(store, "builtin:removed");
    expect(missing.nodes).toEqual([]);
    expect(missing.edges).toEqual([]);
    expect(resolveDefaultWorkflowIr().nodes).toEqual([]);
  });
});

pgDescribe("custom workflow project lifecycle", () => {
  const harness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_custom_only" });
  beforeAll(harness.beforeAll);
  afterAll(harness.afterAll);
  beforeEach(harness.beforeEach);
  afterEach(harness.afterEach);
  it("starts empty, accepts settings, and uses an explicitly authored default", async () => {
    const store = harness.store();
    expect(await store.listWorkflowDefinitions()).toEqual([]);
    expect(await store.listWorkflowDefinitions({includeDisabledBuiltins:true})).toEqual([]);
    expect(await store.getDefaultWorkflowId()).toBe("");
    await store.updateSettings({ enabledBuiltinWorkflowIds: [], enginePaused: true });
    expect(await store.materializeDefaultWorkflowSteps()).toBeUndefined();
    const custom = await store.createWorkflowDefinition({ name: "My process", ir: BUILTIN_CODING_WORKFLOW_IR });
    await store.setDefaultWorkflowId(custom.id);
    expect(await store.getDefaultWorkflowId()).toBe(custom.id);
    expect((await store.materializeDefaultWorkflowSteps())?.workflowId).toBe(custom.id);
    await expect(store.setDefaultWorkflowId("builtin:coding")).rejects.toThrow("custom");
    await expect(store.materializeExplicitWorkflowSteps("builtin:coding")).rejects.toThrow("history");
    await store.setDefaultWorkflowId(null);
    await store.deleteWorkflowDefinition(custom.id);
    expect(await store.listWorkflowDefinitions()).toEqual([]);
  });
  it("keeps private historical snapshots readable and out of every catalog", async () => {
    const store = harness.store();
    const custom = await store.createWorkflowDefinition({name:"Saved process",ir:BUILTIN_CODING_WORKFLOW_IR});
    await store.asyncLayer!.db.insert(schema.project.workflows).values({...custom,id:"builtin:saved",projectId:store.asyncLayer!.projectId!});
    expect((await store.getWorkflowDefinition("builtin:saved"))?.ir).toEqual(custom.ir);
    expect((await store.listWorkflowDefinitions({includeDisabledBuiltins:true})).map(w => w.id)).toEqual([custom.id]);
    expect(await resolveWorkflowIrById(store,"builtin:saved")).toEqual(custom.ir);
  });
  it("does not erase a saved task's workflow selection when deleting its definition", async () => {
    const store = harness.store();
    const custom = await store.createWorkflowDefinition({name:"Saved process",ir:BUILTIN_CODING_WORKFLOW_IR});
    const task = await store.createTask({description:"Preserve my workflow",workflowId:custom.id});
    await expect(store.deleteWorkflowDefinition(custom.id)).rejects.toThrow("saved tasks");
    expect((await store.getTaskWorkflowSelectionAsync(task.id))?.workflowId).toBe(custom.id);
    expect(await store.getWorkflowDefinition(custom.id)).toBeDefined();
  });

});
