import type { WorkflowIr } from "../workflows/workflow-ir-types.js";
import { buildBoardWorkflowsPayload } from "../../../dashboard/src/routes/board-workflows.js";
import * as schema from "../postgres/schema/index.js";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { BUILTIN_WORKFLOWS, getBuiltinWorkflow, defaultEnabledBuiltinWorkflowIds, effectiveEnabledBuiltinWorkflowIds, resolveEffectiveDefaultWorkflowId, resolveDefaultWorkflowIr } from "../workflows/builtin-workflows.js";
import { resolveWorkflowIrById } from "../workflows/workflow-ir-resolver.js";
import { pgDescribe, createTaskStoreForTest, type PgTestHarness, createSharedPgTaskStoreTestHarness } from "../__test-utils__/pg-test-harness.js";
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

// FNXC:WorkflowDeletion 2026-09-08-12:54: Preserve deleted-task history without making its graph selectable; live references and the project default remain deletion blockers.
const ir: WorkflowIr = { version:'v2',name:'History fixture',columns:[{id:'triage',name:'Inbox',traits:[{trait:'intake'}]},{id:'done',name:'Complete',traits:[{trait:'complete'}]}],nodes:[{id:'start',kind:'start',column:'triage'},{id:'end',kind:'end',column:'done'}],edges:[{from:'start',to:'end',condition:'success'}],settings:[{id:'strict',name:'Strict',type:'boolean',default:false}] };
pgDescribe('deleted task workflow history',()=>{
 let h:PgTestHarness;
 beforeAll(async()=>{h=await createTaskStoreForTest({prefix:'workflow_history',projectId:'history-test'});});
 afterAll(async()=>{if(h)await h.teardown();});
 it('deletes a workflow after its last task is deleted and retains the exact historical definition',async()=>{
  const wf=await h.store.createWorkflowDefinition({name:'Saved process',ir});
  const task=await h.store.createTask({description:'Synthetic history task',workflowId:wf.id});
  await h.store.updateWorkflowSettingValues(wf.id,'history-test',{strict:true});
  await expect(h.store.deleteWorkflowDefinition(wf.id)).rejects.toThrow('live tasks');
  await h.store.deleteTask(task.id);
  await h.store.deleteWorkflowDefinition(wf.id);
  expect(await h.store.listWorkflowDefinitions()).not.toContainEqual(expect.objectContaining({id:wf.id}));
  expect(await h.store.getWorkflowDefinition(wf.id)).toMatchObject({id:wf.id,kind:'historical',ir:wf.ir});
  expect((await h.store.getTaskWorkflowSelectionAsync(task.id))?.workflowId).toBe(wf.id);
  expect(await h.store.getWorkflowSettingValuesAsync(wf.id,'history-test')).toEqual({strict:true});
  const board=await buildBoardWorkflowsPayload(h.store,[task.id]);
  expect(board.workflows.find(w=>w.id===wf.id)).toMatchObject({selectable:false});
  expect(board.workflows.find(w=>w.id===wf.id)?.columns).toHaveLength(2);
  await expect(h.store.updateWorkflowSettingValues(wf.id,'history-test',{strict:false})).rejects.toThrow('Deleted');
  await expect(h.store.updateWorkflowPromptOverrides(wf.id,'history-test',{})).rejects.toThrow('Deleted');
  await expect(h.store.materializeExplicitWorkflowSteps(wf.id)).rejects.toThrow('history');
  await expect(h.store.setDefaultWorkflowId(wf.id)).rejects.toThrow('Deleted');
  await expect(h.store.updateWorkflowDefinition(wf.id,{name:'Overwrite history'})).rejects.toThrow('Deleted');
  await expect(h.store.createTask({description:'Must not select deleted graph',workflowId:wf.id})).rejects.toThrow('workflow-unresolvable');
  await h.store.deleteWorkflowDefinition(wf.id);
  expect(await h.store.getWorkflowDefinition(wf.id)).toBeDefined();
 });
 it('keeps a workflow blocked while any live task still references it',async()=>{
  const wf=await h.store.createWorkflowDefinition({name:'Mixed references',ir});
  const gone=await h.store.createTask({description:'Deleted reference',workflowId:wf.id});
  await h.store.createTask({description:'Live reference',workflowId:wf.id});await h.store.deleteTask(gone.id);
  await expect(h.store.deleteWorkflowDefinition(wf.id)).rejects.toThrow('live tasks');
  expect((await h.store.getWorkflowDefinition(wf.id))?.kind).toBe('workflow');
 });
 it('removes an unused definition but refuses the configured default',async()=>{
  const wf=await h.store.createWorkflowDefinition({name:'Unused',ir});await h.store.setDefaultWorkflowId(wf.id);
  await expect(h.store.deleteWorkflowDefinition(wf.id)).rejects.toThrow('default');
  await h.store.setDefaultWorkflowId(null);await h.store.deleteWorkflowDefinition(wf.id);
  expect(await h.store.getWorkflowDefinition(wf.id)).toBeUndefined();
 });
});
