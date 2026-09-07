import { describe, expect, it, vi } from "vitest";
import { createChatStreamHandlers } from "../createChatStreamHandlers";
import type { ToolCallInfo } from "../chatTypes";

describe("createChatStreamHandlers", () => {
  it.each(["completed", "failed", "reattached"])("clears responder progress and pending frames after %s", (boundary) => {
    vi.useFakeTimers();
    try {
      const text = vi.fn();
      const thinking = vi.fn();
      const tools = vi.fn();
      const done = vi.fn();
      const agentMessage = vi.fn();
      const { handlers } = createChatStreamHandlers({
        sessionId: "s-1", tempUserMessageId: "temp",
        ...(boundary === "reattached" ? { initialText: "Old snapshot", initialThinking: "Old thinking", initialToolCalls: [{ toolName: "read", isError: false, status: "running" as const }] } : {}),
        setStreamingText: text, setStreamingThinking: thinking, setStreamingToolCalls: tools,
        cancelStreamingFlushesRef: { current: null }, onDone: done, onError: vi.fn(), onAgentMessage: agentMessage,
      });
      handlers.onText("First agent");
      handlers.onThinking("First thinking");
      handlers.onToolStart({ toolName: "read" });
      if (boundary === "completed") handlers.onAgentMessage?.({ message: {} as any, senderAgentId: "a", senderAgentName: "A" });
      else handlers.onAgentStart();
      vi.runOnlyPendingTimers();
      expect(text).toHaveBeenLastCalledWith("");
      expect(thinking).toHaveBeenLastCalledWith("");
      expect(tools).toHaveBeenLastCalledWith([]);
      handlers.onText("Second agent");
      handlers.onToolStart({ toolName: "write", args: { path: "b.ts" } });
      handlers.onToolEnd({ toolName: "write", isError: false, result: "written" });
      vi.runOnlyPendingTimers();
      expect(text).toHaveBeenLastCalledWith("Second agent");
      handlers.onDone({ messageId: "", dispatch: "agents" });
      expect(done).toHaveBeenCalledWith(expect.objectContaining({ accumulated: expect.objectContaining({
        text: "Second agent", thinking: "", toolCalls: [{ toolName: "write", args: { path: "b.ts" }, isError: false, result: "written", status: "completed" }],
      }) }));
    } finally { vi.useRealTimers(); }
  });

  it.each([
    {
      name: "empty delta sandwiched between spaced chunks",
      chunks: ["Hello.", "", " World."],
      expected: "Hello. World.",
    },
    {
      name: "multiple sentence boundaries across four chunks",
      chunks: ["One.", " Two.", " Three.", " Four."],
      expected: "One. Two. Three. Four.",
    },
    {
      name: "whitespace-only final delta immediately before done",
      chunks: ["Trailing", " "],
      expected: "Trailing ",
    },
  ])("preserves whitespace across streamed text deltas (%s)", ({ chunks, expected }) => {
    vi.useFakeTimers();

    let text = "";
    const onDone = vi.fn();
    const onError = vi.fn();
    const cancelStreamingFlushesRef = { current: null } as { current: (() => void) | null };

    const { handlers } = createChatStreamHandlers({
      sessionId: "s-1",
      tempUserMessageId: "temp-1",
      setStreamingText: (value) => {
        text = typeof value === "function" ? value(text) : value;
      },
      setStreamingThinking: vi.fn(),
      setStreamingToolCalls: vi.fn(),
      cancelStreamingFlushesRef,
      onDone,
      onError,
    });

    for (const chunk of chunks) {
      handlers.onText(chunk);
    }

    vi.advanceTimersToNextTimer();

    expect(text).toBe(expected);

    handlers.onDone({ messageId: "m-1" });
    expect(onDone).toHaveBeenCalledWith({
      messageId: "m-1",
      message: undefined,
      accumulated: {
        text: expected,
        thinking: "",
        toolCalls: [],
        fallbackInfo: undefined,
      },
    });
    expect(onError).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("FN-6632 seeds reattached accumulators before appending new chunks", () => {
    vi.useFakeTimers();

    let text = "Hello ";
    let thinking = "thinking…";
    let toolCalls: ToolCallInfo[] = [
      { toolName: "read", status: "completed", isError: false, result: "seeded" },
    ];
    const onDone = vi.fn();
    const cancelStreamingFlushesRef = { current: null } as { current: (() => void) | null };

    const { handlers } = createChatStreamHandlers({
      sessionId: "s-1",
      tempUserMessageId: "",
      initialText: "Hello ",
      initialThinking: "thinking…",
      initialToolCalls: toolCalls,
      setStreamingText: (value) => {
        text = typeof value === "function" ? value(text) : value;
      },
      setStreamingThinking: (value) => {
        thinking = typeof value === "function" ? value(thinking) : value;
      },
      setStreamingToolCalls: (value) => {
        toolCalls = typeof value === "function" ? value(toolCalls) : value;
      },
      cancelStreamingFlushesRef,
      onDone,
      onError: vi.fn(),
    });

    handlers.onText("world");
    handlers.onText("!");
    handlers.onThinking(" more");
    handlers.onToolStart({ toolName: "write", args: { path: "a.ts" } });
    handlers.onToolEnd({ toolName: "write", isError: false, result: "done" });

    vi.advanceTimersToNextTimer();
    vi.advanceTimersToNextTimer();

    expect(text).toBe("Hello world!");
    expect(thinking).toBe("thinking… more");
    expect(toolCalls).toEqual([
      { toolName: "read", status: "completed", isError: false, result: "seeded" },
      { toolName: "write", args: { path: "a.ts" }, status: "completed", isError: false, result: "done" },
    ]);

    handlers.onDone({ messageId: "m-1" });
    expect(onDone).toHaveBeenCalledWith({
      messageId: "m-1",
      message: undefined,
      accumulated: {
        text: "Hello world!",
        thinking: "thinking… more",
        toolCalls,
        fallbackInfo: undefined,
      },
    });

    vi.useRealTimers();
  });
});
