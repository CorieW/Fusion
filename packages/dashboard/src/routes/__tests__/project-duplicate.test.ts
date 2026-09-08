// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerProjectRoutes } from "../register-project-routes.js";
import type { ApiRoutesContext } from "../types.js";
const copy = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../lib/duplicate-project.js", () => ({ copyProjectConfiguration: copy }));
vi.mock("../../project-store-resolver.js", () => ({ getOrCreateProjectStore: vi.fn(async id => ({ id })), evictProjectStore: vi.fn() }));
const roots: string[] = [];
afterEach(async () => { vi.clearAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function harness() {
  const root = await mkdtemp(join(tmpdir(), "fusion-project-copy-test-")); roots.push(root);
  const sourcePath = join(root, "Source Project"); await mkdir(sourcePath);
  const source = { id: "source", name: "Source", path: sourcePath, isolationMode: "in-process" };
  let created: Record<string, unknown>;
  const central = {
    isInitialized: () => true,
    getProject: vi.fn(async id => id === "source" ? source : created),
    listProjects: vi.fn(async () => [source]),
    ensureProjectForPath: vi.fn(async input => {
      await mkdir(join(input.path, ".fusion"));
      created = { ...input, id: "proj_1234567890abcdef", status: "initializing", createdAt: new Date().toISOString() };
      return { outcome: "registered", project: created };
    }),
    updateProject: vi.fn(async (_id, patch) => created = { ...created, ...patch }),
  };
  let handler: (req: unknown, res: unknown) => Promise<unknown>;
  const router = Object.fromEntries(["get", "patch", "delete", "put", "post"].map(method => [method, vi.fn((route, callback) => { if (method === "post" && route === "/projects/:id/duplicate") handler = callback; })]));
  registerProjectRoutes({ router, options: { centralCore: central }, rethrowAsApiError: error => { throw error; } } as unknown as ApiRoutesContext);
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  return { root, sourcePath, central, res, run: (path: string) => handler({ params: { id: "source" }, body: { name: "Copy", path } }, res) };
}
describe("project duplicate route", () => {
  it("refuses an existing destination without overwriting its files", async () => {
    const h = await harness(); const destination = join(h.root, "Existing"); await mkdir(destination); await writeFile(join(destination, "work.txt"), "Keep");
    await expect(h.run(destination)).rejects.toThrow("new folder");
    expect(await readFile(join(destination, "work.txt"), "utf8")).toBe("Keep");
    expect(h.central.ensureProjectForPath).not.toHaveBeenCalled(); expect(copy).not.toHaveBeenCalled();
  });
  it("refuses a copy inside the source project", async () => {
    const h = await harness();
    await expect(h.run(join(h.sourcePath, "Nested"))).rejects.toThrow("outside existing projects");
    expect(copy).not.toHaveBeenCalled();
  });
  it("creates a new paused project at a path with spaces before copying configuration", async () => {
    const h = await harness(); await h.run(join(h.root, "New Project"));
    expect(h.res.status).toHaveBeenCalledWith(201);
    expect(h.res.json).toHaveBeenCalledWith(expect.objectContaining({ id: "proj_1234567890abcdef", status: "paused" }));
    expect(copy).toHaveBeenCalledWith({ id: "source" }, { id: "proj_1234567890abcdef" });
  });
  it("leaves an incomplete copy paused and reports the failure", async () => {
    const h = await harness(); copy.mockRejectedValueOnce(new Error("disk full"));
    await expect(h.run(join(h.root, "New Project"))).rejects.toThrow("new project remains paused");
    expect(h.central.updateProject).toHaveBeenLastCalledWith("proj_1234567890abcdef", { status: "paused" });
    expect(h.res.json).not.toHaveBeenCalled();
  });
});

it('ignores an unrelated missing directory without losing overlap protection',async()=>{
 const h=await harness();const source=(await h.central.listProjects())[0];
 h.central.listProjects.mockResolvedValue([source,{...source,id:'offline',path:join(h.root,'Offline Project')}]);
 await h.run(join(h.root,'New Project'));expect(h.res.status).toHaveBeenCalledWith(201);
});
it('a missing registered root still reserves its exact destination',async()=>{
 const h=await harness();const source=(await h.central.listProjects())[0];const destination=join(h.root,'Offline Project');
 h.central.listProjects.mockResolvedValue([source,{...source,id:'offline',path:destination}]);
 await expect(h.run(destination)).rejects.toThrow('outside existing projects');expect(copy).not.toHaveBeenCalled();
});
it('does not hide permission failures while resolving registered roots',async()=>{
 const {resolveRegisteredProjectPath}=await import('../../lib/project-path.js');
 await expect(resolveRegisteredProjectPath('unreadable',async()=>{throw Object.assign(new Error('denied'),{code:'EACCES'});})).rejects.toThrow('denied');
});
