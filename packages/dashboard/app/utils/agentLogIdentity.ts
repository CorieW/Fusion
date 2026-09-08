import type { AgentLogEntry } from "@fusion/core";

/** Keep adjacent agents distinct even when their roles or display names match. */
export function agentLogIdentityKey(entry: AgentLogEntry): string {
  return JSON.stringify([entry.agent ?? "", entry.agentId?.trim() ?? "", entry.agentName?.trim() ?? ""]);
}

export function agentLogDisplayName(entry: AgentLogEntry, fallback: string): string {
  return entry.agentName?.trim() || fallback;
}
