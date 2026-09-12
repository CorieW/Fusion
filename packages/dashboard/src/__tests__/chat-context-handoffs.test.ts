import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatStore, AgentStore } from "@fusion/core";
import { ChatManager, __resetChatState, __setBuildAgentChatPrompt, __setCreateFnAgent, __setCreateResolvedAgentSession } from "../chat.js";
import { createHandoffReporter, isOrderedHandoff } from "../chat-handoff.js";

vi.mock("@earendil-works/pi-coding-agent", () => ({ SessionManager: { create: vi.fn(() => ({ getSessionFile: () => null, getLeafId: () => null })), open: vi.fn(() => ({ getSessionFile: () => null, getLeafId: () => null })) } }));

type Row = { id: string; sessionId: string; roomId: string; role: string; content: string; createdAt: string; metadata?: Record<string, unknown> };
const findings = "Non-blocking: match unusual status handling; correct the update-path error label.";
function harness(kind: "session" | "room") {
  const agents = [{ id: "coder", name: "Coder", role: "executor", state: "idle", runtimeConfig: {} }, { id: "reviewer", name: "Reviewer", role: "reviewer", state: "idle", runtimeConfig: {} }];
  const rows: Row[] = [{ id: "objective", sessionId: "thread", roomId: "thread", role: "user", content: "Maintain compatibility.", createdAt: "2026-09-11T00:00:00Z" },
    { id: "review", sessionId: "thread", roomId: "thread", role: "assistant", content: "Review pass: details. ".repeat(300) + findings, createdAt: "2026-09-11T00:00:01Z" }];
  const list = async (_id: string, filter: { order?: string; offset?: number; limit?: number } = {}) => (filter.order === "asc" ? rows : rows.slice().reverse()).slice(filter.offset ?? 0, (filter.offset ?? 0) + (filter.limit ?? 200));
  const add = vi.fn(async (_id: string, input: object) => { const row = { ...input, id: `m${rows.length}`, sessionId: "thread", roomId: "thread", createdAt: new Date().toISOString() } as Row; rows.push(row); return row; });
  const store = { getSession: async () => ({ id: "thread", agentId: "coder", projectId: null, status: "active" }), getRoom: async () => ({ id: "thread", name: "team", projectId: null }),
    getMessages: list, getRoomMessages: list, getMessage: async (id: string) => rows.find(row => row.id === id), getRoomMessage: async (id: string) => rows.find(row => row.id === id),
    addMessage: add, addRoomMessage: add, listRoomMembers: async () => agents.map(agent => ({ agentId: agent.id, role: "member" })),
    setInFlightGeneration: vi.fn(), setCliSessionFile: vi.fn(), updateMessageMetadata: vi.fn(), recordTokenUsage: vi.fn(),
  } as unknown as ChatStore;
  const agentStore = { init: vi.fn(), listAgents: async () => agents, getAgent: async (id: string) => agents.find(agent => agent.id === id) } as unknown as AgentStore;
  const manager = new ChatManager(store, "/tmp/fusion-chat-context-test", agentStore);
  return { manager, rows, add, send: (content = "@Coder address both non-blocking points. Then, @Reviewer perform a final review.") => kind === "session" ? manager.sendMessage("thread", content) : manager.sendRoomMessage("thread", content) };
}
beforeEach(() => { __resetChatState(); __setBuildAgentChatPrompt(async ({ basePrompt }: { basePrompt: string }) => basePrompt); });
afterEach(() => { __resetChatState(); vi.restoreAllMocks(); });

it("recognizes explicit sequencing without confusing name prefixes or ordinary if-then discussion", () => {
  const mentions = [{ agentId: "anna", agentName: "Anna" }, { agentId: "ann", agentName: "Ann" }];
  expect(isOrderedHandoff("@Anna implement. Then, @Ann review.", mentions)).toBe(true);
  expect(isOrderedHandoff("@Anna discuss if-then statements and @Ann offer an opinion.", mentions)).toBe(false);
});

it.each(["fn_chat_handoff", "mcp__fusion__fn_chat_handoff", "Report Chat Handoff", "Tool"])("accepts settled work with the runtime report label %s", async name => {
  const reporter = createHandoffReporter(true);
  reporter.onToolStart("Reading file");
  reporter.onToolStart("Reading file");
  reporter.onToolEnd("Read file finished", false);
  const report = { status: "completed", summary: "Done", evidence: ["Verified revision"] };
  await reporter.tool.execute("too-early", report);
  expect(reporter.getOutcome()).toBeUndefined();
  reporter.onToolEnd("Read file finished", false);
  expect(reporter.getOutcome()).toBeUndefined();
  reporter.onToolStart(name);
  const result = await reporter.tool.execute("done", report);
  expect(result.isError).toBeUndefined();
  expect(reporter.getOutcome()).toBeUndefined();
  reporter.onToolEnd("Renamed tool", false, JSON.stringify(result));
  expect(reporter.getOutcome()?.status).toBe("completed");
});

it("correlates a report even when its runtime start notification arrives after execution", async () => {
  const reporter = createHandoffReporter(true);
  const result = await reporter.tool.execute("report", { status: "completed", summary: "Done", evidence: ["Verified revision"] });
  reporter.onToolStart("Tool");
  expect(reporter.getOutcome()).toBeUndefined();
  reporter.onToolEnd("Updated display title", false, result);
  expect(reporter.getOutcome()?.status).toBe("completed");
});

describe.each(["session", "room"] as const)("%s handoff acceptance", kind => {
  it("runs repeated participants as separate ordered steps", async () => {
    const { send } = harness(kind);
    const instructions: string[] = [];
    __setCreateResolvedAgentSession(async (options: any) => ({ session: {
      state: { messages: [{ role: "assistant", content: "Completed this step" }] }, dispose: vi.fn(),
      prompt: async () => {
        instructions.push(options.systemPrompt);
        await options.customTools.find((tool: any) => tool.name === "fn_chat_handoff").execute("handoff", { status: "completed", summary: "Step done", evidence: ["Verified this step"] });
      },
    } }));
    await send("@Coder implement. Then @Reviewer review. Then @Coder address the review.");
    expect(instructions).toHaveLength(3);
    for (let i = 0; i < 3; i++) expect(instructions[i]).toContain(`Ordered handoff step ${i + 1} of 3`);
  });
  it.each(["native", "cli-bridge"])("passes the full review, persisted result and working notes through %s", async runtime => {
    const { rows, send } = harness(kind);
    const prompts: string[] = [];
    const create = async (options: any) => {
      const index = prompts.length;
      return { session: { model: { contextWindow: 64000 }, state: { messages: [{ role: "assistant", content: index === 0 ? "Fixed both; revision abc123; targeted checks passed." : "Reviewed revision abc123 in several passes." }] }, dispose: vi.fn(),
        prompt: async (prompt: string) => {
          prompts.push(prompt);
          expect(prompt).toContain(findings);
          expect(options.customTools.map((tool: any) => tool.name)).toEqual(expect.arrayContaining(["fn_chat_thread_read", "fn_chat_thread_search", "fn_chat_context_update"]));
          if (index === 0) {
            options.onToolStart("test", { scope: "status cases" });
            options.onToolEnd("test", false, "Both findings verified on revision abc123");
            const update = options.customTools.find((tool: any) => tool.name === "fn_chat_context_update");
            const result = await update.execute("notes", { notes: [{ id: "compatibility", kind: "constraint", status: "accepted", text: "Maintain compatibility", sourceMessageIds: ["objective"] }] });
            expect(result.isError).toBeUndefined();
          }
          const reportName = runtime === "native" ? "fn_chat_handoff" : "Tool";
          options.onToolStart(reportName);
          const reportResult = await options.customTools.find((tool: any) => tool.name === "fn_chat_handoff").execute("handoff", { status: "completed", summary: index === 0 ? "Fixed both findings" : "Reviewed", evidence: ["revision abc123; targeted checks passed"] });
          options.onToolEnd(reportName, false, runtime === "native" ? reportResult : JSON.stringify(reportResult));
        } } };
    };
    if (runtime === "native") __setCreateFnAgent(create); else __setCreateResolvedAgentSession(create);
    await send();
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Fixed both; revision abc123; targeted checks passed.");
    expect(prompts[1]).toContain('"id":"compatibility"');
    expect(rows.at(-1)?.metadata?.handoff).toEqual(expect.objectContaining({ status: "completed" }));
    expect(rows.at(-1)?.metadata?.contextReport).toEqual(expect.objectContaining({ deferredRequiredMessageIds: [] }));
    expect(rows.find(row => row.content.startsWith("Fixed both;"))?.metadata?.toolCalls).toEqual(expect.arrayContaining([expect.objectContaining({ toolName: "test", result: "Both findings verified on revision abc123" })]));
  });

  it.each(["blocked", "unreported", "failed", "creation-failed", "skipped", "work-after-report", "work-in-flight"])("does not start the reviewer after %s work", async outcome => {
    const { rows, send } = harness(kind);
    const create = vi.fn(async (options: any) => {
      if (outcome === "creation-failed") throw new Error("provider unavailable");
      return { session: { state: { messages: [{ role: "assistant", content: outcome === "skipped" ? "__SKIP__" : "Partial work; cannot verify." }] }, dispose: vi.fn(), prompt: async () => {
        if (outcome === "failed") throw new Error("provider failed");
        if (outcome === "blocked") await options.customTools.find((tool: any) => tool.name === "fn_chat_handoff").execute("handoff", { status: "blocked", summary: "Verification unavailable", evidence: [] });
        if (outcome === "work-after-report") {
          await options.customTools.find((tool: any) => tool.name === "fn_chat_handoff").execute("handoff", { status: "completed", summary: "Done", evidence: ["Checks passed"] });
          options.onToolStart("write", { path: "changed-after-checks.ts" });
        }
        if (outcome === "work-in-flight") {
          options.onToolStart("write", { path: "still-changing.ts" });
          await options.customTools.find((tool: any) => tool.name === "fn_chat_handoff").execute("handoff", { status: "completed", summary: "Done", evidence: ["Checks passed"] });
          options.onToolEnd("write", false, "Changed after the report");
        }
      } } };
    });
    __setCreateResolvedAgentSession(create);
    await send().catch(() => undefined);
    expect(create).toHaveBeenCalledTimes(1);
    expect(rows.at(-1)?.content).toContain("Handoff stopped");
    expect(rows.some(row => row.metadata?.senderAgentId === "reviewer")).toBe(false);
  });

  it("keeps independent group mentions independent after a failed responder", async () => {
    const { send } = harness(kind);
    let count = 0;
    __setCreateResolvedAgentSession(async () => { if (++count === 1) throw new Error("first provider unavailable"); return { session: { prompt: vi.fn(), dispose: vi.fn(), state: { messages: [{ role: "assistant", content: "Independent opinion" }] } } }; });
    await send("@Coder @Reviewer offer your opinions");
    expect(count).toBe(2);
  });
  it("does not skip an unresolved participant and start its dependent reviewer", async () => {
    const { rows, send } = harness(kind);
    const create = vi.fn(); __setCreateResolvedAgentSession(create);
    await send("@Missing_Coder fix both. Then @Reviewer review.");
    expect(create).not.toHaveBeenCalled();
    expect(rows.at(-1)?.content).toContain("Handoff stopped");
  });
  it("does not release a reviewer when its predecessor reply cannot be saved", async () => {
    const { add, send } = harness(kind);
    const original = add.getMockImplementation()!;
    add.mockImplementation(async (id, input) => { if ((input as { role: string }).role === "assistant") throw new Error("storage unavailable"); return original(id, input); });
    const create = vi.fn(async (options: any) => ({ session: { state: { messages: [{ role: "assistant", content: "Completed" }] }, dispose: vi.fn(), prompt: async () => {
      await options.customTools.find((tool: any) => tool.name === "fn_chat_handoff").execute("handoff", { status: "completed", summary: "Done", evidence: ["Checked revision abc123"] });
    } } }));
    __setCreateResolvedAgentSession(create);
    await send().catch(() => undefined);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

it("returns mentioned-agent replies to the original direct model on the next ordinary turn", async () => {
  const { send } = harness("session");
  const prompts: string[] = [];
  __setCreateResolvedAgentSession(async () => ({ session: { prompt: async (prompt: string) => { prompts.push(prompt); }, dispose: vi.fn(), state: { messages: [{ role: "assistant", content: "Coder changed revision abc123." }] } } }));
  await send("@Coder inspect the review and preserve the legacy status rules");
  await send("What did the coder do?");
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain("Coder changed revision abc123.");
  expect(prompts[1]).toContain("@Coder inspect the review and preserve the legacy status rules");
});
