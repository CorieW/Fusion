/*
FNXC:NavigationGroups 2026-09-07-17:41:
Desktop/tablet sidebar and mobile navigation share one hierarchy: Dashboard stands alone,
Tasks holds Board/List, AI holds Chat/Agents/Workflows/Memory, and Other sorts by displayed label.
Callers filter unavailable or pinned destinations first, so empty groups never leave a shell.
*/
export type NavigationGroupId = "tasks" | "ai" | "other";
export const DEFAULT_NAVIGATION_GROUPS: Record<NavigationGroupId, boolean> = {
  tasks: true, ai: true, other: false,
};

export function groupNavigationEntries<T extends { id: string; label: string }>(entries: T[]) {
  const pick = (ids: string[]) => ids.flatMap(id => {
    const entry = entries.find(candidate => candidate.id === id);
    return entry ? [entry] : [];
  });
  const primaryIds = new Set(["command-center", "board", "list", "chat", "agents", "workflows", "memory"]);
  return {
    dashboard: pick(["command-center"]),
    groups: [
      { id: "tasks" as const, label: "Tasks", entries: pick(["board", "list"]) },
      { id: "ai" as const, label: "AI", entries: pick(["chat", "agents", "workflows", "memory"]) },
      { id: "other" as const, label: "Other", entries: entries.filter(entry => !primaryIds.has(entry.id)).sort((a, b) => a.label.localeCompare(b.label)) },
    ].filter(group => group.entries.length > 0),
  };
}
