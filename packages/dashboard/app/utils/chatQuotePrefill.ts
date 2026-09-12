/*
FNXC:ChatQuoteReply 2026-08-23-02:31:
Quoting an agent-authored message must re-emit its mention token so the next direct-chat turn is routed back to that agent.
*/
export function buildChatQuotePrefill({
  quotedText,
  agentName,
  existingDraft,
  messageId,
}: {
  quotedText: string;
  agentName?: string | null;
  existingDraft: string;
  messageId?: string;
}): string {
  const normalized = quotedText.replace(/"/g, "'").replace(/\s+/g, " ").trim();
  if (!normalized) return existingDraft;
  const excerpt = normalized.length > 200 ? `${normalized.slice(0, 200)}…` : normalized;
  const mention = agentName?.trim() ? `@${agentName.trim().replace(/\s+/g, "_")} , ` : "";
  // FNXC:ChatContext 2026-09-11-15:57: A short visible quote carries the original message identity so handoffs retrieve its complete source.
  const source = messageId && /^[\w-]+$/.test(messageId) ? `[Quoted message](#chat-message-${messageId}) ` : "";
  const prefix = `"${excerpt}" - ${source}${mention}`;
  return `${prefix}${existingDraft.replace(/^"[^"]*" - (\[Quoted message\]\(#chat-message-[\w-]+\) )?(@[\w-]+ , )?/, "")}`;
}
