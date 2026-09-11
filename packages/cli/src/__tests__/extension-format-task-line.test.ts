import { describe, expect, it } from "vitest";
import type { Task } from "@fusion/core";
import { formatTaskLine } from "../extension.js";

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: "FN-0001",
    title: "Example task",
    description: "Example description",
    priority: "normal",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    size: "S",
    reviewLevel: 1,
    ...overrides,
  } as Task;
}

describe("formatTaskLine", () => {
  it.each([
    { paused: true, column: "todo", expectPaused: true },
    { paused: true, column: "in-progress", expectPaused: true },
    { paused: true, column: "in-review", expectPaused: true },
    { paused: true, column: "done", expectPaused: false },
    // FNXC:ProblemReporting 2026-09-11-14:11: Archive is a deleted-row storage marker, removed from live listings. Custom problem columns must retain their human-hold marker.
    { paused: true, column: "problems", expectPaused: true },
    { paused: true, column: "resolved-problems", expectPaused: true },
    { paused: false, column: "done", expectPaused: false },
  ] as const)("preserves holds except for the built-in Complete fallback (%o)", ({ paused, column, expectPaused }) => {
    const line = formatTaskLine(makeTask({ paused, column }));
    if (expectPaused) {
      expect(line).toContain("(paused)");
    } else {
      expect(line).not.toContain("(paused)");
    }
  });
});
