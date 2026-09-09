import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as asyncChatStore from "../../../core/src/async-stores/async-chat-store.js";
import type { ChatSession } from "@fusion/core";
import {
  __resetScopedChatManagerCache,
  __resetScopedChatStoreCache,
  getOrCreateScopedChatStore,
  getOrCreateScopedChatManager,
  resolveProjectChatContext,
} from "../chat-project-services.js";

function createStore(fusionDir = "/tmp/fusion-project") {
  const layer = { db: {} };
  return {
    getFusionDir: vi.fn(() => fusionDir),
    getRootDir: vi.fn(() => "/tmp/project"),
    getSettings: vi.fn(async () => ({})),
    getDatabase: vi.fn(() => ({})),
    // FNXC:PostgresCutover 2026-07-16-06:30: dashboard service doubles must
    // expose the AsyncDataLayer contract used by AgentStore after SQLite removal.
    getAsyncLayer: vi.fn(() => layer),
  } as any;
}

function createChatStore() {
  return {} as any;
}

describe("project-scoped ChatManager cache", () => {
  beforeEach(() => {
    __resetScopedChatManagerCache();
    __resetScopedChatStoreCache();
  });

  afterEach(() => vi.restoreAllMocks());

  it.each(["codex", "claude-code"])("rebinds %s chat persistence across repeated pause/resume at the same path", async (adapter) => {
    const firstStore = createStore();
    const firstLayer = firstStore.getAsyncLayer();
    const firstChat = getOrCreateScopedChatStore(firstStore);
    const session = { id: "chat-lifecycle", agentId: "agent-1", projectId: "project-a", cliExecutorAdapterId: adapter } as ChatSession;
    const closedHandles = new Set<object>();
    vi.spyOn(asyncChatStore, "getChatSession").mockImplementation(async (handle, id) => {
      if (closedHandles.has(handle)) throw new Error("write CONNECTION_ENDED");
      return id === session.id ? session : undefined;
    });
    vi.spyOn(asyncChatStore, "createChatSession").mockImplementation(async (handle, created) => {
      if (closedHandles.has(handle)) throw new Error("write CONNECTION_ENDED");
      return created;
    });
    vi.spyOn(asyncChatStore, "getChatRoom").mockImplementation(async (handle) => {
      if (closedHandles.has(handle)) throw new Error("write CONNECTION_ENDED");
      return undefined;
    });

    const manager = getOrCreateScopedChatManager(firstStore, firstChat);
    const send = vi.fn(async () => "sent" as const);
    manager.setCliChatRunner({ ensureSession: vi.fn(async () => "cli-1"), send });
    await manager.sendMessage(session.id, "before pause");

    // Exercise repeated replacement, including returning to an engine-owned store.
    let previousLayer = firstLayer;
    for (let cycle = 0; cycle < 2; cycle++) {
      closedHandles.add(previousLayer.db);
      const replacement = createStore();
      const replacementChat = getOrCreateScopedChatStore(replacement);
      const rebound = getOrCreateScopedChatManager(replacement, replacementChat);
      await expect(rebound.sendMessage(session.id, `after replacement ${cycle}`)).resolves.toBeUndefined();
      expect(replacementChat).not.toBe(firstChat);
      expect(getOrCreateScopedChatStore(replacement)).toBe(replacementChat);
      expect(rebound).toBe(manager);
      await expect(replacementChat.getSession(session.id)).resolves.toEqual(session);
      await expect(replacementChat.getSession("missing")).resolves.toBeUndefined();
      await expect(rebound.createSession({ agentId: "agent-1", projectId: "project-a" })).resolves.toMatchObject({ agentId: "agent-1" });
      await expect(rebound.sendMessage("missing", "empty conversation lookup")).resolves.toBeUndefined();
      await expect(rebound.sendRoomMessage("missing-room", "hello")).rejects.toThrow("Chat room missing-room not found");
      previousLayer = replacement.getAsyncLayer();
    }
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("preserves an active generation and CLI runner when its persistence changes", async () => {
    const firstStore = createStore();
    const session = { id: "active-chat", projectId: "project-a", cliExecutorAdapterId: "codex" };
    const firstChat = { getSession: vi.fn(async () => session) } as any;
    const manager = getOrCreateScopedChatManager(firstStore, firstChat);
    let releaseSend!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    manager.setCliChatRunner({
      ensureSession: async () => "cli-1",
      send: async () => {
        markStarted();
        await new Promise<void>((resolve) => { releaseSend = resolve; });
        return "sent";
      },
    });
    const sending = manager.sendMessage(session.id, "hello");
    await started;
    const replacement = createStore();
    const rebound = getOrCreateScopedChatManager(replacement, createChatStore());
    expect(rebound.isGenerating(session.id)).toBe(true);
    releaseSend();
    await sending;
    expect(rebound.isGenerating(session.id)).toBe(false);
  });

  it("replaces a layer on the same TaskStore and clears obsolete engine services", () => {
    const store = createStore();
    const chat = getOrCreateScopedChatStore(store);
    const manager = getOrCreateScopedChatManager(store, chat, {} as any, true, {} as any);
    store.getAsyncLayer.mockReturnValue({ db: {} });
    const nextChat = getOrCreateScopedChatStore(store);
    const rebound = getOrCreateScopedChatManager(store, nextChat);
    expect(nextChat).not.toBe(chat);
    expect(rebound).toBe(manager);
    expect((rebound as any).pluginRunner).toBeUndefined();
    expect((rebound as any).messageStore).toBeUndefined();
    expect((rebound as any).taskStore).toBe(store);
  });

  it("uses the matching engine ChatStore without borrowing a different backend at the same path", async () => {
    const store = createStore();
    const engineChat = createChatStore();
    const engineManager = { getEngine: () => ({ getTaskStore: () => store, getChatStore: () => engineChat }) } as any;
    const context = await resolveProjectChatContext({ projectId: "project-a", defaultStore: store, requestStore: store, engineManager });
    expect(context.chatStore).toBe(engineChat);
    const replacement = createStore();
    const next = await resolveProjectChatContext({ projectId: "project-a", defaultStore: store, requestStore: replacement, engineManager });
    expect(next.chatStore).not.toBe(engineChat);
  });

  it("keeps other project bindings intact when one project replaces its backend", () => {
    const first = createStore("/project-a/.fusion");
    const second = createStore("/project-b/.fusion");
    const secondChat = getOrCreateScopedChatStore(second);
    const secondManager = getOrCreateScopedChatManager(second, secondChat);
    getOrCreateScopedChatManager(first, getOrCreateScopedChatStore(first));
    const replacement = createStore("/project-a/.fusion");
    getOrCreateScopedChatManager(replacement, getOrCreateScopedChatStore(replacement));
    expect(getOrCreateScopedChatStore(second)).toBe(secondChat);
    expect(getOrCreateScopedChatManager(second, secondChat)).toBe(secondManager);
  });

  it("passes the engine MessageStore into a newly constructed scoped manager", () => {
    const store = createStore();
    const chatStore = createChatStore();
    const pluginRunner = { getRuntimeById: vi.fn() };
    const messageStore = { sendMessage: vi.fn(), getInbox: vi.fn() };

    const manager = getOrCreateScopedChatManager(store, chatStore, pluginRunner as any, true, messageStore as any);

    expect((manager as any).messageStore).toBe(messageStore);
  });

  it("upgrades a cached manager when the engine boots after first resolution", () => {
    const store = createStore();
    const chatStore = createChatStore();
    const initialPluginRunner = { getRuntimeById: vi.fn(() => undefined) };
    const enginePluginRunner = { getRuntimeById: vi.fn(() => ({ id: "runtime" })) };
    const messageStore = { sendMessage: vi.fn(), getInbox: vi.fn() };

    const preBootManager = getOrCreateScopedChatManager(store, chatStore, initialPluginRunner as any, false, undefined);
    expect((preBootManager as any).messageStore).toBeUndefined();

    const upgradedManager = getOrCreateScopedChatManager(store, chatStore, enginePluginRunner as any, true, messageStore as any);

    expect(upgradedManager).toBe(preBootManager);
    expect((upgradedManager as any).pluginRunner).toBe(enginePluginRunner);
    expect((upgradedManager as any).messageStore).toBe(messageStore);
  });

  it("keeps a request's secondary store when its engine is unavailable", async () => {
    const defaultStore = createStore("/tmp/default/.fusion");
    const secondaryStore = createStore("/tmp/secondary/.fusion");
    const defaultChatStore = createChatStore();

    const context = await resolveProjectChatContext({
      projectId: "secondary-project",
      defaultStore,
      defaultChatStore,
      requestStore: secondaryStore,
      engineManager: { getEngine: vi.fn(() => undefined) } as any,
    });

    expect(context.store).toBe(secondaryStore);
    expect(context.chatStore).not.toBe(defaultChatStore);
  });

  it("preserves plugin-runner refresh semantics alongside MessageStore refresh", () => {
    const store = createStore();
    const chatStore = createChatStore();
    const fallbackPluginRunner = { getRuntimeById: vi.fn(() => undefined) };
    const enginePluginRunner = { getRuntimeById: vi.fn(() => ({ id: "runtime" })) };
    const messageStore = { sendMessage: vi.fn(), getInbox: vi.fn() };

    const manager = getOrCreateScopedChatManager(store, chatStore, fallbackPluginRunner as any, false, undefined);
    const cached = getOrCreateScopedChatManager(store, chatStore, enginePluginRunner as any, true, messageStore as any);

    expect(cached).toBe(manager);
    expect((cached as any).pluginRunner).toBe(enginePluginRunner);
    expect((cached as any).messageStore).toBe(messageStore);
  });
});
