import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { runCursorCommand } from "../../../../plugins/fusion-plugin-cursor-runtime/src/cli-spawn.js";
import { runGrokCommand } from "../../../../plugins/fusion-plugin-grok-runtime/src/cli-spawn.js";
import { runOmpCommand } from "../../../../plugins/fusion-plugin-omp-runtime/src/cli-spawn.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
const spawnMock = vi.mocked(spawn);
const denied = Object.assign(new Error("Process launch denied"), { code: "EACCES" });
// FNXC:ProviderProbe 2026-09-08-18:22: Cursor, Grok and OMP share the status/discovery runner contract: launch refusals resolve as failed commands, never reject an entire provider inventory.
describe.each([["Cursor", runCursorCommand], ["Grok", runGrokCommand], ["OMP", runOmpCommand]] as const)("%s launch refusals", (_name, run) => {
  beforeEach(() => { spawnMock.mockReset(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
  afterEach(() => { expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); });
  it("reports synchronous launch refusals", async () => {
    spawnMock.mockImplementation(() => { throw denied; });
    await expect(run("synthetic", ["--version"], 100)).resolves.toEqual({ code: 127, stdout: "", stderr: "spawn error: EACCES: Process launch denied" });
  });
  it("preserves the same result for event-delivered refusals", async () => {
    spawnMock.mockImplementation(() => {
      const process = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
      queueMicrotask(() => process.emit("error", denied));
      return process as unknown as ReturnType<typeof spawn>;
    });
    await expect(run("synthetic", ["--version"], 100)).resolves.toEqual({ code: 127, stdout: "", stderr: "spawn error: EACCES: Process launch denied" });
  });
  it("retains successful command output", async () => {
    spawnMock.mockImplementation(() => {
      const process = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
      queueMicrotask(() => { process.stdout.emit("data", Buffer.from("fixture 1.0")); process.emit("close", 0); });
      return process as unknown as ReturnType<typeof spawn>;
    });
    await expect(run("synthetic", ["--version"], 100)).resolves.toEqual({ code: 0, stdout: "fixture 1.0", stderr: "" });
  });
});
