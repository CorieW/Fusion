import { describe, expect, it, vi } from "vitest";
import type { WorkflowDefinition } from "@fusion/core";
import { getBuiltinWorkflow } from "../../../core/src/__test-utils__/legacy-workflows/builtin-workflows.js";
import { buildBoardWorkflowsPayload } from "../routes/board-workflows.js";

const historical = structuredClone(getBuiltinWorkflow("builtin:coding")!);
const custom: WorkflowDefinition = { ...structuredClone(historical), id: "WF-CUSTOM", name: "My workflow" };
function store(definitions: WorkflowDefinition[] = [], defaultWorkflowId?: string) {
  return {
    getSettings: vi.fn(async () => ({ defaultWorkflowId })),
    getTaskWorkflowSelection: vi.fn((_id: string): {workflowId: string} | undefined => undefined),
    getWorkflowDefinition: vi.fn(async (id: string) => definitions.find(d => d.id === id)),
    listWorkflowDefinitions: vi.fn(async () => definitions.filter(d => !d.id.startsWith("builtin:"))),
  };
}
describe("board workflows without bundled templates", () => {
  it("renders a new project's empty catalog without a phantom Coding lane", async () => {
    const payload = await buildBoardWorkflowsPayload(store() as never, []);
    expect(payload.defaultWorkflowId).toBe("");
    expect(payload.workflows).toEqual([]);
  });
  it("does not revive a built-in through old project settings", async () => {
    const old = store([], "builtin:coding");
    old.getSettings.mockResolvedValue({defaultWorkflowId:"builtin:coding",enabledBuiltinWorkflowIds:["builtin:coding"]} as never);
    expect((await buildBoardWorkflowsPayload(old as never, [])).workflows).toEqual([]);
  });
  it("offers custom workflows even before a project default is chosen", async () => {
    const payload = await buildBoardWorkflowsPayload(store([custom]) as never, []);
    expect(payload.workflows.map(w => [w.id,w.selectable])).toEqual([[custom.id,true]]);
    expect(payload.defaultWorkflowId).toBe("");
  });
  it("shows saved historical definitions without offering them for new work", async () => {
    const data = store([custom,historical],custom.id);
    data.getTaskWorkflowSelection.mockImplementation(id => id === "OLD" ? {workflowId:historical.id} : undefined);
    const payload = await buildBoardWorkflowsPayload(data as never, ["OLD","NEW"]);
    expect(payload.taskWorkflowIds).toEqual({OLD:historical.id,NEW:custom.id});
    expect(payload.workflows.find(w => w.id === historical.id)).toMatchObject({name:historical.name,selectable:false});
    expect(payload.workflows.find(w => w.id === historical.id)?.columns.map(c => c.id)).toEqual(historical.ir.columns!.map(c => c.id));
    expect(payload.workflows.filter(w => w.selectable).map(w => w.id)).toEqual([custom.id]);
  });
  it("preserves custom column names and descriptions", async () => {
    const named = structuredClone(custom);
    named.ir.columns![0].name = "My intake";
    named.ir.columns![0].description = "Plan work\nwith the team";
    const payload = await buildBoardWorkflowsPayload(store([named],named.id) as never, []);
    expect(payload.workflows[0]?.columns[0]).toMatchObject({name:"My intake",description:"Plan work\nwith the team"});
    expect(payload.workflows[0]?.columns[1]).not.toHaveProperty("description");
  });
  it("does not substitute a Coding graph for a missing historical definition", async () => {
    const data = store();
    data.getTaskWorkflowSelection.mockReturnValue({workflowId:"builtin:missing"});
    const payload = await buildBoardWorkflowsPayload(data as never,["OLD"]);
    expect(payload.workflows).toHaveLength(1);
    expect(payload.workflows[0]).toMatchObject({id:"builtin:missing",selectable:false,columns:[]});
  });
});
