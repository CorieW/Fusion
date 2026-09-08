import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { probeClaudeCli } from "../claude-cli-probe.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
const denied = Object.assign(new Error("External command execution is disabled"), { code: "EACCES" });
const spawnMock = vi.mocked(spawn);
function child(outcome: { stdout?: string; error?: Error; code?: number }) {
  const process = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  queueMicrotask(() => {
    if (outcome.stdout) process.stdout.emit("data", Buffer.from(outcome.stdout));
    if (outcome.error) process.emit("error", outcome.error);
    else process.emit("close", outcome.code ?? 0);
  });
  return process as unknown as ReturnType<typeof spawn>;
}
// FNXC:ProviderProbe 2026-09-08-18:18: Cover both lookup and execution refusals without launching installed providers; a failed probe never claims authentication or retains a timer.
describe("Claude CLI launch refusals", () => {
  beforeEach(() => { spawnMock.mockReset(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
  afterEach(() => { expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); });
  it("resolves unavailable when both lookup and execution throw synchronously", async () => {
    spawnMock.mockImplementation(() => { throw denied; });
    await expect(probeClaudeCli()).resolves.toMatchObject({ available: false, reason: denied.message });
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });
  it.each(["/synthetic/claude", "C:\\synthetic\\claude.exe"])("preserves the discovered path when execution is refused: %s", async path => {
    spawnMock.mockImplementationOnce(() => child({ stdout: `${path}\n` })).mockImplementationOnce(() => { throw denied; });
    await expect(probeClaudeCli()).resolves.toMatchObject({ available: false, binaryPath: path, reason: denied.message });
  });
  it("handles event-delivered lookup and execution errors equivalently", async () => {
    spawnMock.mockImplementation(() => child({ error: denied }));
    await expect(probeClaudeCli()).resolves.toMatchObject({ available: false, reason: denied.message });
  });
  it("still probes PATH successfully when only the optional path lookup is refused", async () => {
    spawnMock.mockImplementationOnce(() => { throw denied; }).mockImplementationOnce(() => child({ stdout: "Claude fixture 1.0\n" }));
    await expect(probeClaudeCli()).resolves.toMatchObject({ available: true, version: "Claude fixture 1.0" });
    expect(spawnMock.mock.calls[1][0]).toBe("claude");
  });
  it("retains an unavailable result for a nonzero process exit", async () => {
    spawnMock.mockImplementationOnce(() => child({ code: 1 })).mockImplementationOnce(() => child({ code: 2 }));
    await expect(probeClaudeCli()).resolves.toMatchObject({ available: false, reason: "claude --version exited with code 2" });
  });
});
