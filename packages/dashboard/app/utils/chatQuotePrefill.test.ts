import { describe, expect, it } from "vitest";
import { buildChatQuotePrefill } from "./chatQuotePrefill";

describe("buildChatQuotePrefill", () => {
  it("retains a stable reference to the full original beyond the visible excerpt", () => {
    const quote = buildChatQuotePrefill({ quotedText: "review ".repeat(1000) + "finding at the end", messageId: "msg-original", agentName: "Coder", existingDraft: "fix both" });
    expect(quote).toContain("[Quoted message](#chat-message-msg-original)");
    expect(quote).toContain("@Coder , fix both");
    const replacement = buildChatQuotePrefill({ quotedText: "replacement", messageId: "msg-new", existingDraft: quote });
    expect(replacement).not.toContain("msg-original");
    expect(replacement).toContain("#chat-message-msg-new");
    expect(replacement).toContain("fix both");
  });
  it("creates a mention-compatible agent quote", () => {
    expect(buildChatQuotePrefill({ quotedText: "hello", agentName: "Workflow Planner", existingDraft: "next" }))
      .toBe('"hello" - @Workflow_Planner , next');
  });

  it("normalizes excerpts and replaces an existing prefix", () => {
    const quote = buildChatQuotePrefill({ quotedText: '  a\n"b"  ', existingDraft: '"old" - @Avery , next' });
    expect(quote).toBe('"a \'b\'" - next');
  });

  it("keeps the draft when there is no quoteable content", () => {
    expect(buildChatQuotePrefill({ quotedText: " \n", existingDraft: "draft" })).toBe("draft");
  });
});
