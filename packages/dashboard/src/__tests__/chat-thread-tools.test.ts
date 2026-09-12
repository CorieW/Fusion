import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatStore } from "@fusion/core";
import { createThreadAccess, loadThreadContext, type ThreadMessage, type WorkingNote } from "../chat-thread-context.js";
import { createThreadTools } from "../chat-thread-tools.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function harness(kind: "session" | "room", messages: ThreadMessage[]) {
  const rows = messages.map(message => ({ ...message, sessionId: "thread", roomId: "thread" }));
  const list = async (_id: string, filter: { offset?: number; limit?: number; order?: string } = {}) => (filter.order === "asc" ? rows : rows.slice().reverse()).slice(filter.offset ?? 0, (filter.offset ?? 0) + (filter.limit ?? 200));
  const store = { getSession: async () => ({ projectId: "p" }), getRoom: async () => ({ projectId: "p" }), getMessages: list, getRoomMessages: list,
    getMessage: async (id: string) => rows.find(message => message.id === id), getRoomMessage: async (id: string) => rows.find(message => message.id === id) } as unknown as ChatStore;
  const access = createThreadAccess(store, { kind, id: "thread", projectId: "p" });
  return { access, controller: createThreadTools(access), rows, store };
}
const message = (id: string, content: string, extra: Partial<ThreadMessage> = {}): ThreadMessage => ({ id, content, role: "user", createdAt: "2026-09-11T00:00:00Z", ...extra });
async function call(controller: ReturnType<typeof createThreadTools>, name: string, args: object) {
  const response = await controller.tools.find(tool => tool.name === name)!.execute("call", args);
  return { ...response, data: JSON.parse((response.content[0] as { text: string }).text) };
}

describe.each(["session", "room"] as const)("%s conversation retrieval", kind => {
  it("recovers every character of a long message and tool result", async () => {
    const text = "review ".repeat(6000) + "FINAL FINDINGS";
    const evidence = [{ toolName: "test", result: "output ".repeat(6000) + "FINAL EVIDENCE" }];
    const { controller } = harness(kind, [message("review", text, { metadata: { toolCalls: evidence } })]);
    for (const [part, expected] of [["content", text], ["tools", JSON.stringify(evidence)]]) {
      let recovered = ""; let offset = 0;
      do {
        const { data } = await call(controller, "fn_chat_thread_read", { message_id: "review", part, char_offset: offset });
        recovered += data.text;
        if (data.nextCharOffset === null) break;
        expect(data.nextCharOffset).toBeGreaterThan(offset);
        offset = data.nextCharOffset;
      } while (offset < expected.length);
      expect(recovered).toBe(expected);
    }
  });
  it("searches beyond the latest 400 messages with explicit continuation", async () => {
    const { controller } = harness(kind, [message("early", "critical constraint"), ...Array.from({ length: 450 }, (_, i) => message(`m${i}`, "ordinary"))]);
    let offset = 0; const matches: string[] = [];
    do {
      const { data } = await call(controller, "fn_chat_thread_search", { query: "critical", offset });
      matches.push(...data.matches.map((match: { id: string }) => match.id));
      if (data.nextOffset === null) break;
      offset = data.nextOffset;
    } while (offset < 451);
    expect(matches).toEqual(["early"]);
  });
  it("rejects foreign-conversation and foreign-project message IDs", async () => {
    const { controller, rows, store } = harness(kind, [message("foreign", "secret")]);
    rows[0].sessionId = "other"; rows[0].roomId = "other";
    expect((await call(controller, "fn_chat_thread_read", { message_id: "foreign" })).isError).toBe(true);
    store.getSession = async () => ({ projectId: "elsewhere" }) as never;
    store.getRoom = async () => ({ projectId: "elsewhere" }) as never;
    const response = await call(controller, "fn_chat_thread_search", { query: "secret" });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response)).not.toContain("secret");
  });
  it("loads a quoted source outside the recent window and carries working notes", async () => {
    const note: WorkingNote = { id: "constraint-1", kind: "constraint", status: "accepted", text: "Keep compatibility", sourceMessageIds: ["early"] };
    const { access } = harness(kind, [message("early", "Keep compatibility"), ...Array.from({ length: 250 }, (_, i) => message(`m${i}`, "later")), message("checkpoint", "progress", { metadata: { workingNotes: [note] } })]);
    const loaded = await loadThreadContext(access, "[Quoted message](#chat-message-early)");
    expect(loaded.messages.find(row => row.id === "early")?.content).toBe("Keep compatibility");
    expect(loaded.notes).toEqual([note]);
    expect(loaded.olderHistoryAvailable).toBe(true);
  });
  it.each([false, true])("recovers the latest checkpoint beyond the fetch window (cleared=%s)", async cleared => {
    const note: WorkingNote = { id: "constraint", kind: "constraint", status: "accepted", text: "Keep compatibility", sourceMessageIds: ["early"] };
    const { access } = harness(kind, [message("early", "Keep compatibility"),
      message("old-checkpoint", "saved", { metadata: { workingNotes: [note] } }),
      ...(cleared ? [message("clear-checkpoint", "resolved", { metadata: { workingNotes: [] } })] : []),
      ...Array.from({ length: 450 }, (_, i) => message(`later${i}`, "later"))]);
    expect((await loadThreadContext(access, "continue")).notes).toEqual(cleared ? [] : [note]);
  });
  it("updates stable finding IDs and requires real user sources for accepted decisions", async () => {
    const { controller } = harness(kind, [message("user", "Keep compatibility"), message("agent", "proposal", { role: "assistant" })]);
    const note: WorkingNote = { id: "finding-1", kind: "finding", status: "open", text: "Correct label", sourceMessageIds: ["agent"] };
    expect((await call(controller, "fn_chat_context_update", { notes: [note] })).isError).toBeUndefined();
    await call(controller, "fn_chat_context_update", { notes: [{ ...note, status: "resolved" }] });
    expect(controller.getNotes()).toEqual([{ ...note, status: "resolved" }]);
    expect((await call(controller, "fn_chat_context_update", { notes: [], archive_ids: ["finding-1"] })).isError).toBeUndefined();
    expect(controller.getNotes()).toEqual([]);
    await call(controller, "fn_chat_context_update", { notes: [note] });
    expect((await call(controller, "fn_chat_context_update", { notes: [], archive_ids: ["finding-1"] })).isError).toBe(true);
    expect((await call(controller, "fn_chat_context_update", { notes: [{ ...note, kind: "decision", status: "accepted" }] })).isError).toBe(true);
    expect((await call(controller, "fn_chat_context_update", { notes: [{ ...note, sourceMessageIds: ["missing"] }] })).isError).toBe(true);
  });
  it("does not carry notes whose source message has been deleted", async () => {
    const { access } = harness(kind, [message("new", "current"), message("checkpoint", "progress", { metadata: { workingNotes: [{ id: "old", kind: "constraint", status: "accepted", text: "Stale requirement", sourceMessageIds: ["deleted"] }] } })]);
    const loaded = await loadThreadContext(access, "continue");
    expect(loaded.notes).toEqual([]);
    expect(loaded.missingReferenceIds).toContain("deleted");
  });
  it("retrieves an attachment beyond the old 50KB inline cutoff", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-chat-context-")); roots.push(root);
    const directory = join(root, ".fusion", kind === "session" ? "chat-attachments" : "chat-room-attachments", "thread");
    await mkdir(directory, { recursive: true });
    const text = "a".repeat(60_000) + "TAIL REQUIREMENT";
    await writeFile(join(directory, "review.txt"), text);
    const { access } = harness(kind, [message("source", "see attachment", { attachments: [{ id: "file", filename: "review.txt", originalName: "review.txt", mimeType: "text/plain", size: text.length, createdAt: "now" }] })]);
    const { data } = await call(createThreadTools(access, [], root), "fn_chat_thread_read", { message_id: "source", attachment_id: "file", char_offset: 60_000 });
    expect(data.text).toBe("TAIL REQUIREMENT");
    expect(data.nextCharOffset).toBeNull();
  });
});
