import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SimpleCanvasAutoFit } from "../WorkflowSimpleCanvas";

const control = vi.hoisted(() => ({
  fitView: vi.fn(),
  state: { nodesInitialized: false, width: 0, height: 0, nodeLookup: new Map<string, { id: string; hidden?: boolean; measured: { width: number; height: number }; internals: { positionAbsolute: { x: number; y: number } } }>() },
}));
vi.mock("@xyflow/react", async importOriginal => ({
  ...await importOriginal<typeof import("@xyflow/react")>(),
  useReactFlow: () => ({ fitView: control.fitView }),
  useStore: (selector: (state: typeof control.state) => unknown) => selector(control.state),
}));
let sequence = 0;
const frames = new Map<number, FrameRequestCallback>();
function paint() { act(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)); }); }
// FNXC:WorkflowViewport 2026-09-08-18:18: The viewport and node measurements, not elapsed time, authorize auto-fit. Cover both zero-sized axes, resizes, cancellation, and measured bounds changes.
describe("simple workflow viewport readiness", () => {
  beforeEach(() => {
    control.fitView.mockReset();
    control.state.width = 0; control.state.height = 0; control.state.nodeLookup.clear(); frames.clear();
    control.state.nodeLookup.set("start", { id: "start", measured: { width: 100, height: 32 }, internals: { positionAbsolute: { x: 0, y: 0 } } });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { const id = ++sequence; frames.set(id, callback); return id; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  });
  afterEach(() => { cleanup(); expect(frames.size).toBe(0); vi.unstubAllGlobals(); });
  it.each([[0, 0], [390, 0], [0, 844]])("does not fit against an unpublished viewport (%s × %s)", (width, height) => {
    control.state.width = width; control.state.height = height;
    const view = render(<SimpleCanvasAutoFit />); paint(); expect(control.fitView).not.toHaveBeenCalled();
    control.state.width = 390; control.state.height = 844; view.rerender(<SimpleCanvasAutoFit />); paint();
    expect(control.fitView).toHaveBeenCalledExactlyOnceWith({ padding: 0.15, maxZoom: 1 });
  });
  it("waits for internal measurements even when the controlled-node initialization flag stays false", () => {
    control.state.width = 390; control.state.height = 844; control.state.nodeLookup.get("start")!.measured.width = 0;
    const view = render(<SimpleCanvasAutoFit />); paint(); expect(control.fitView).not.toHaveBeenCalled();
    control.state.nodeLookup.get("start")!.measured.width = 100; view.rerender(<SimpleCanvasAutoFit />); paint(); expect(control.fitView).toHaveBeenCalledTimes(1);
  });
  it("refits on viewport and node-bound changes without refitting unrelated renders", () => {
    control.state.width = 1440; control.state.height = 1000;
    const view = render(<SimpleCanvasAutoFit />); paint();
    control.state.width = 390; control.state.height = 844; view.rerender(<SimpleCanvasAutoFit />); paint();
    control.state.nodeLookup.get("start")!.measured.width = 160; view.rerender(<SimpleCanvasAutoFit />); paint();
    control.state.nodeLookup.get("start")!.internals.positionAbsolute.y = 120; view.rerender(<SimpleCanvasAutoFit />); paint();
    view.rerender(<SimpleCanvasAutoFit />); paint(); expect(control.fitView).toHaveBeenCalledTimes(4);
  });
  it("does not fit an empty or entirely hidden graph", () => {
    control.state.width = 390; control.state.height = 844; control.state.nodeLookup.clear();
    const view = render(<SimpleCanvasAutoFit />); paint();
    control.state.nodeLookup.set("hidden", { id: "hidden", hidden: true, measured: { width: 100, height: 32 }, internals: { positionAbsolute: { x: 0, y: 0 } } });
    view.rerender(<SimpleCanvasAutoFit />); paint(); expect(control.fitView).not.toHaveBeenCalled();
  });
  it("cancels a queued fit if the canvas becomes hidden before the frame", () => {
    control.state.width = 390; control.state.height = 844;
    const view = render(<SimpleCanvasAutoFit />);
    control.state.width = 0; view.rerender(<SimpleCanvasAutoFit />); paint(); expect(control.fitView).not.toHaveBeenCalled();
  });
});
