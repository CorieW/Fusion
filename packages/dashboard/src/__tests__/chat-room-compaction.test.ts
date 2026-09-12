import { describe, expect, it } from "vitest";
import { buildThreadContext, contextTokenBudget, estimateContextTokens, type ThreadMessage } from "../chat-thread-context.js";
const message = (id: string, content: string, role: ThreadMessage["role"] = "assistant"): ThreadMessage => ({ id, role, content, createdAt: "2026-09-11T00:00:00Z" });

// FNXC:ChatContext 2026-09-11-15:57: Whole-message selection replaces the removed fixed-length excerpt contract.
describe("shared room/direct context selection", () => {
  it("preserves findings at the end of a long preceding review", () => {
    const review = "Review pass. ".repeat(500) + "Non-blocking: handle unusual status values; correct update log label.";
    const built = buildThreadContext({ messages: [message("review", review), message("user", "@Coder fix both", "user")], latestUserMessageId: "user" });
    expect(built.text).toContain(review);
    expect(built.report.includedMessageIds).toContain("review");
    expect(built.report.deferredRequiredMessageIds).toEqual([]);
  });
  it("selects complete messages within the token budget, including Unicode", () => {
    const messages = Array.from({ length: 80 }, (_, i) => message(`m${i}`, `Message ${i}: ${"\u5b57 and code {}; ".repeat(120)}`));
    const built = buildThreadContext({ messages, latestUserMessageId: "m79", tokenBudget: 4000 });
    expect(built.report.omittedMessageIds.length).toBeGreaterThan(0);
    expect(built.report.estimatedTokens).toBeLessThanOrEqual(4000);
    for (const id of built.report.includedMessageIds) expect(built.text).toContain(messages.find(m => m.id === id)!.content);
    expect(built.text).toContain(messages[78].content);
  });
  it("identifies oversized dependencies for retrieval without cutting their contents", () => {
    const built = buildThreadContext({ messages: [message("review", "Large review ".repeat(5000)), message("user", "fix both", "user")], latestUserMessageId: "user", tokenBudget: 2000 });
    expect(built.report.deferredRequiredMessageIds).toEqual(["review"]);
    expect(built.text).toContain("Required messages to retrieve before acting: review");
    expect(built.text).not.toContain("Large review");
  });
  it("preserves referenced older messages and predecessor replies", () => {
    const messages = [message("source", "original findings"), ...Array.from({ length: 50 }, (_, i) => message(`old${i}`, "noise ".repeat(100))), message("user", "fix then review", "user"), message("coder", "Changed revision abc123; tested status cases.")];
    const built = buildThreadContext({ messages, latestUserMessageId: "user", requiredMessageIds: ["source"], tokenBudget: 1800 });
    expect(built.text).toContain("original findings");
    expect(built.text).toContain("Changed revision abc123");
  });
  it("handles empty and duplicate input and missing references", () => {
    expect(buildThreadContext({ messages: [], latestUserMessageId: "user" }).report.includedMessageIds).toEqual([]);
    const built = buildThreadContext({ messages: [message("review", "one"), message("review", "latest")], latestUserMessageId: "user", missingReferenceIds: ["deleted"] });
    expect(built.report.includedMessageIds).toEqual(["review"]);
    expect(built.text).toContain("Unavailable references: deleted");
  });
  it("reserves model capacity for instructions, tools, and generation", () => {
    const small = contextTokenBudget({ contextWindow: 16000, maxTokens: 4000 }, "system ".repeat(500));
    expect(small).toBeLessThan(12000);
    expect(contextTokenBudget({ contextWindow: 64000 }, "system")).toBeGreaterThan(small);
    expect(estimateContextTokens("\u5b57".repeat(1000))).toBeGreaterThanOrEqual(1000);
  });
  it("budgets omission notices as well as message bodies", () => {
    const messages = [message("user", "review all responses", "user"), ...Array.from({ length: 200 }, (_, i) => message(`response-${String(i).padStart(32, "0")}`, "Large response ".repeat(6000)))];
    const built = buildThreadContext({ messages, latestUserMessageId: "user", tokenBudget: 1800 });
    expect(built.report.deferredRequiredMessageIds).toHaveLength(200);
    expect(built.report.estimatedTokens).toBeLessThanOrEqual(1800);
    expect(built.text).toContain("fn_chat_thread_read");
  });
});
