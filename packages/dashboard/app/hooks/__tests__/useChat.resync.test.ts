import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSession } from "@fusion/core";

/*
FNXC:ChatRealtime 2026-07-26-20:30:
Reconnect-resync coverage for chat. The latch under test: `streamRef` is cleared ONLY by the stream's
own onDone/onError, so a transport iOS killed during a background suspend without delivering either
leaves a dead stream marked live — and every later reconnect handler that guarded on it became a
permanent no-op (frozen transcript, reply never lands, no refetch ever attempted). The invariant is
that a reconnect reconciles the local stream against the server's generation state rather than
trusting it.
*/

vi.mock("../../api", () => ({
  fetchChatSessions: vi.fn(),
  fetchChatTags: vi.fn().mockResolvedValue({ tags: [] }),
  fetchChatSession: vi.fn(),
  createChatSession: vi.fn(),
  fetchChatMessages: vi.fn(),
  updateChatSession: vi.fn(),
  deleteChatSession: vi.fn(),
  streamChatResponse: vi.fn(),
  attachChatStream: vi.fn(),
  cancelChatResponse: vi.fn(),
  fetchAgents: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../utils/projectStorage", () => ({
  getScopedItem: vi.fn(),
  setScopedItem: vi.fn(),
  removeScopedItem: vi.fn(),
}));

const { sseOptions } = vi.hoisted(() => ({
  sseOptions: { current: null as null | { onReconnect?: () => void } },
}));

vi.mock("../../sse-bus", () => ({
  subscribeSse: vi.fn((_url: string, opts: { onReconnect?: () => void }) => {
    sseOptions.current = opts;
    return () => {};
  }),
}));

import { useChat } from "../useChat";
import * as apiModule from "../../api";

const mockFetchChatSessions = vi.mocked(apiModule.fetchChatSessions);
const mockFetchChatSession = vi.mocked(apiModule.fetchChatSession);
const mockFetchChatMessages = vi.mocked(apiModule.fetchChatMessages);
const mockAttachChatStream = vi.mocked(apiModule.attachChatStream);

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "session-001",
    agentId: "agent-001",
    status: "active",
    title: null,
    projectId: null,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    createdAt: "2026-04-08T00:00:00.000Z",
    updatedAt: "2026-04-08T00:00:00.000Z",
    pinnedAt: null,
    cliSessionFile: null,
    cliExecutorAdapterId: null,
    inFlightGeneration: null,
    ...overrides,
  } as ChatSession;
}

describe("useChat reconnect resync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sseOptions.current = null;
    mockFetchChatMessages.mockResolvedValue({ messages: [] } as never);
  });

  it.each(["send", "reattach"])("retains and deduplicates completed mentioned-agent replies during %s", async (mode) => {
    const { result } = await renderWithAttachedStream(mode === "reattach");
    const handlers = mode === "reattach" ? mockAttachChatStream.mock.calls.at(-1)![1]
      : vi.mocked(apiModule.streamChatResponse).mock.calls.at(-1)![2];
    const message = {
      id: "mentioned-reply", sessionId: "session-001", role: "assistant" as const,
      content: "First agent finished", thinkingOutput: "Reviewed files",
      metadata: { senderAgentId: "agent-001", senderAgentName: "Avery", toolCalls: [{ toolName: "read", isError: false, result: "contents" }] },
      createdAt: "2026-04-08T00:01:00.000Z",
    };
    act(() => {
      handlers.onAgentMessage?.({ message: message as never, senderAgentId: "agent-001", senderAgentName: "Avery" });
      handlers.onAgentStart?.({ senderAgentId: "agent-002", senderAgentName: "Blair" });
      handlers.onToolStart?.({ toolName: "write", args: { path: "next.ts" } });
    });
    expect(result.current.isStreaming).toBe(true);
    expect(result.current.messages.filter((item) => item.role === "assistant")).toEqual([expect.objectContaining({ content: "First agent finished", toolCalls: [expect.objectContaining({ toolName: "read", status: "completed" })] })]);
    expect(result.current.streamingToolCalls).toEqual([expect.objectContaining({ toolName: "write", status: "running" })]);
    act(() => handlers.onAgentMessage?.({ message: message as never, senderAgentId: "agent-001", senderAgentName: "Avery" }));
    expect(result.current.messages.filter((item) => item.role === "assistant")).toHaveLength(1);
  });

  /** Renders the hook with one generating session selected and a stream attached. */
  async function renderWithAttachedStream(isGenerating = true) {
    const generating = { ...makeSession(), isGenerating, inFlightGeneration: null };
    mockFetchChatSessions.mockResolvedValue({ sessions: [generating] } as never);
    mockFetchChatSession.mockResolvedValue({ session: generating } as never);
    const close = vi.fn();
    mockAttachChatStream.mockReturnValue({ close, isConnected: () => true } as never);

    const rendered = renderHook(() => useChat(undefined));
    await waitFor(() => {
      expect(rendered.result.current.sessions).toHaveLength(1);
    });

    act(() => {
      rendered.result.current.selectSession("session-001");
    });
    if (isGenerating) {
      await waitFor(() => expect(mockAttachChatStream).toHaveBeenCalled());
    } else {
      await waitFor(() => expect(rendered.result.current.activeSession?.id).toBe("session-001"));
      vi.mocked(apiModule.streamChatResponse).mockReturnValue({ close, isConnected: () => true });
      await act(async () => { await rendered.result.current.sendMessage("@Avery help"); });
    }

    return { ...rendered, close };
  }

  it("recovers when the attached stream died without a terminal callback", async () => {
    const { result, close } = await renderWithAttachedStream();

    // The server finished generating while the tab was suspended; the transport never delivered
    // onDone/onError, so streamRef is still set.
    mockFetchChatSession.mockResolvedValue({
      session: { ...makeSession(), isGenerating: false, inFlightGeneration: null },
    } as never);
    const messageLoadsBefore = mockFetchChatMessages.mock.calls.length;

    await act(async () => {
      sseOptions.current?.onReconnect?.();
      await Promise.resolve();
    });

    await waitFor(() => {
      // The dead stream is torn down and the transcript is refetched — not latched off forever.
      expect(close).toHaveBeenCalled();
      expect(mockFetchChatMessages.mock.calls.length).toBeGreaterThan(messageLoadsBefore);
      expect(result.current.isStreaming).toBe(false);
    });
  });

  it("keeps a stream the server confirms is still generating", async () => {
    const { result, close } = await renderWithAttachedStream();

    mockFetchChatSession.mockResolvedValue({
      session: { ...makeSession(), isGenerating: true, inFlightGeneration: null },
    } as never);
    const messageLoadsBefore = mockFetchChatMessages.mock.calls.length;

    await act(async () => {
      sseOptions.current?.onReconnect?.();
      await Promise.resolve();
    });

    expect(close).not.toHaveBeenCalled();
    // The streaming path still owns the transcript: no authoritative reload fights it.
    expect(mockFetchChatMessages.mock.calls.length).toBe(messageLoadsBefore);
    expect(result.current.isStreaming).toBe(true);
  });

  it("reloads the transcript on reconnect when no stream is attached", async () => {
    const idle = makeSession();
    mockFetchChatSessions.mockResolvedValue({ sessions: [idle] } as never);
    mockFetchChatSession.mockResolvedValue({ session: idle } as never);

    const { result } = renderHook(() => useChat(undefined));
    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });
    act(() => {
      result.current.selectSession("session-001");
    });
    await waitFor(() => {
      expect(result.current.activeSession?.id).toBe("session-001");
    });

    const messageLoadsBefore = mockFetchChatMessages.mock.calls.length;
    await act(async () => {
      sseOptions.current?.onReconnect?.();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mockFetchChatMessages.mock.calls.length).toBeGreaterThan(messageLoadsBefore);
    });
    expect(mockAttachChatStream).not.toHaveBeenCalled();
  });
});
