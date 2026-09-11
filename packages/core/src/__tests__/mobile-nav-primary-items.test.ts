import { describe, expect, it } from "vitest";
import { DEFAULT_MOBILE_NAV_PRIMARY_ITEMS, MOBILE_NAV_SELECTABLE_ITEMS, resolveMobileNavPrimaryItems } from "../board/mobile-nav-primary-items.js";

describe("resolveMobileNavPrimaryItems", () => {
  it("uses desktop order for unset or empty values", () => {
    expect(resolveMobileNavPrimaryItems()).toMatchObject({ primaryItems: DEFAULT_MOBILE_NAV_PRIMARY_ITEMS });
    expect(resolveMobileNavPrimaryItems({ mobileNavPrimaryItems: [] })).toMatchObject({ primaryItems: DEFAULT_MOBILE_NAV_PRIMARY_ITEMS });
  });

  it("moves Missions/Mailbox to More and upgrades the saved previous default", () => {
    const previous = ["command-center", "tasks", "agents", "missions", "chat", "mailbox"];
    for (const settings of [undefined, { mobileNavPrimaryItems: previous }]) {
      const result = resolveMobileNavPrimaryItems(settings);
      expect(result.primaryItems).toEqual(["command-center", "tasks", "chat", "agents", "workflows", "memory"]);
      expect(result.omittedItems).toEqual(expect.arrayContaining(["missions", "mailbox"]));
      expect(result.omittedItems).not.toContain("workflows");
    }
    expect(previous).toEqual(["command-center", "tasks", "agents", "missions", "chat", "mailbox"]);
  });

  it("allows unpinning Memory without restoring it or changing custom shortcuts", () => {
    const custom = DEFAULT_MOBILE_NAV_PRIMARY_ITEMS.filter(id => id !== "memory");
    const result = resolveMobileNavPrimaryItems({ mobileNavPrimaryItems: custom });
    expect(result.primaryItems).toEqual(custom);
    expect(result.omittedItems).toContain("memory");
  });

  it("accepts newly eligible destinations, preserves order, and routes omitted destinations to More", () => {
    const resolved = resolveMobileNavPrimaryItems({ mobileNavPrimaryItems: ["git", "recommendations", "planning", "agents"] });
    expect(resolved.primaryItems).toEqual(["git", "recommendations", "planning", "agents"]);
    expect(resolved.omittedItems).not.toContain("git");
    expect(resolved.omittedItems).toContain("settings");
  });

  it("keeps Ideation in More when stale settings try to promote it", () => {
    const resolved = resolveMobileNavPrimaryItems({ mobileNavPrimaryItems: ["ideation"] });

    expect(MOBILE_NAV_SELECTABLE_ITEMS).toContain("ideation");
    expect(resolved.primaryItems).not.toContain("ideation");
    expect(resolved.omittedItems).toContain("ideation");
  });

  it("keeps newly eligible settings and documents, drops overflow-only ids, deduplicates, and clamps footer tabs", () => {
    const resolved = resolveMobileNavPrimaryItems({
      mobileNavPrimaryItems: ["settings", "tasks", "more", "documents", "tasks", "agents", "missions", "chat", "mailbox", "planning", "unknown"],
    });
    expect(resolved.primaryItems).toEqual(["settings", "tasks", "documents", "agents", "missions", "chat"]);
    expect(resolved.omittedItems).not.toContain("settings");
    expect(resolved.omittedItems).not.toContain("documents");
    expect(resolved.omittedItems).toContain("git");
  });
});
