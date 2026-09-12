import type { ChatMention } from "@fusion/core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";

/*
FNXC:ChatHandoff 2026-09-11-15:57:
Explicit then/afterwards handoffs run in mention order. Completion is a structured report, never inferred from a successful model response or optimistic prose. Missing, blocked, failed, and cancelled outcomes cannot release a dependent responder.
*/
export type HandoffOutcome = { status: "completed" | "blocked"; summary: string; evidence: string[] };

function mentionTokens(content: string) {
  return [...content.matchAll(/(?:^|[\s,;:(])@([\w-]+)/g)];
}

export function isOrderedHandoff(content: string, mentions: ChatMention[]): boolean {
  if (mentions.length === 0) return false;
  const positions = mentionTokens(content).map(match => match.index);
  return positions.some((position, index) => index > 0 && /\b(?:then|afterwards|afterward|followed by)[\s,:;-]*(?:(?:please|ask|have)\s*)?$/i.test(content.slice(positions[index - 1], position)));
}

export function unresolvedHandoffNames(content: string, mentions: ChatMention[]): string[] {
  if (!isOrderedHandoff(content, mentions)) return [];
  const known = new Set(mentions.map(mention => mention.agentName.replace(/\s+/g, "_").toLocaleLowerCase()));
  return [...new Set(mentionTokens(content).map(match => match[1]).filter(name => !known.has(name.toLocaleLowerCase())))];
}

export function handoffSequence(content: string, mentions: ChatMention[]): ChatMention[] {
  if (!isOrderedHandoff(content, mentions)) return mentions;
  const known = new Map(mentions.map(mention => [mention.agentName.replace(/\s+/g, "_").toLocaleLowerCase(), mention]));
  return mentionTokens(content).flatMap(match => {
    const mention = known.get(match[1].toLocaleLowerCase());
    return mention ? [mention] : [];
  });
}

export function createHandoffReporter(required: boolean, isActive: () => boolean = () => true) {
  let outcome: HandoffOutcome | undefined;
  let runningTools = 0;
  let receipt = "";
  let reportSettled = false;
  const tool = {
    name: "fn_chat_handoff",
    label: "Report Chat Handoff",
    description: "Report whether your assigned work is completed or blocked. Include changed revision/worktree and verification evidence when applicable. Completed means all requested work for your step is done; partial work is blocked. This report is persisted with your reply, and only completed work releases a dependent agent.",
    parameters: { type: "object", properties: {
      status: { type: "string", enum: ["completed", "blocked"] }, summary: { type: "string", minLength: 1, maxLength: 4000 },
      evidence: { type: "array", items: { type: "string", maxLength: 1000 }, maxItems: 20 },
    }, required: ["status", "summary", "evidence"], additionalProperties: false },
    execute: async (_id: string, raw: HandoffOutcome) => {
      outcome = undefined;
      reportSettled = false;
      if (!isActive() || !raw || !["completed", "blocked"].includes(raw.status) || typeof raw.summary !== "string" || !raw.summary.trim() || raw.summary.length > 4000
        || !Array.isArray(raw.evidence) || raw.evidence.length > 20 || !raw.evidence.every(item => typeof item === "string" && item.length <= 1000)
        || (raw.status === "completed" && !raw.evidence.some(item => item.trim()))) {
        return { content: [{ type: "text", text: "ERROR: wait for outstanding tools, then provide an active handoff, status, summary, and concrete completion evidence (or report blocked)." }], isError: true, details: {} };
      }
      outcome = { status: raw.status, summary: raw.summary.trim(), evidence: [...raw.evidence] };
      receipt = randomUUID();
      reportSettled = runningTools === 0;
      return { content: [{ type: "text", text: JSON.stringify({ message: "Handoff outcome recorded for this reply.", receipt }) }], details: outcome };
    },
  } as unknown as ToolDefinition;
  return { tool, getOutcome: () => runningTools === 0 && reportSettled ? outcome : undefined,
    onToolStart: (_name: string) => {
      reportSettled = false;
      runningTools++;
    },
    onToolEnd: (_name: string, isError: boolean, result?: unknown) => {
      // ACP display titles can change between start and end; correlate the outstanding count.
      runningTools = Math.max(0, runningTools - 1);
      // Correlate the report by its actual result, never an agent-supplied display title.
      let isReportResult = false;
      if (outcome && receipt) {
        try { isReportResult = JSON.stringify(result)?.includes(receipt) === true; } catch { /* Unserializable evidence cannot release a handoff. */ }
      }
      if (outcome && isReportResult && !isError && runningTools === 0) reportSettled = true;
      else { outcome = undefined; reportSettled = false; }
    }, guidance: required
    ? "This is an ordered handoff. Perform only your assigned step from the latest instruction. As your final tool call, use fn_chat_handoff with completed and concrete evidence, or blocked and the reason. Any later tool work invalidates the report. No report means the next agent will not start. Treat predecessor reports as claims to verify, and inspect the reported revision before reviewing."
    : "Use fn_chat_handoff to record completed work or blockers when useful." };
}
