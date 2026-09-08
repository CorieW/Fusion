---
category: ui-bugs
module: workflow activity
tags: [workflow, agents, logs, attribution]
problem_type: incorrect-agent-label
applies_when: Coding or testing workflow output is labeled Reviewer in task activity.
---

# Workflow activity agent labels

Workflow step sessions hardcoded the log role to `reviewer`, inherited from when these sessions only ran review steps. The Activity transcript displayed that role as the agent name. This did not determine which agent executed the step.

Resolve the log role from the graph's existing role classifier and capture the resolved session agent's ID and display name when logging starts. Persist that identity with every entry, including browser-verification status messages. The transcript and log viewer display the captured name and group entries by identity, so adjacent agents sharing a role or name remain separate. Entries without identity retain the previous role-label fallback. Historical identities cannot be reconstructed reliably from the current task assignment.

## Surface Enumeration

- Execution: graph prompt and step sessions, single-repository and workspace dispatch, explicitly declared roles and legacy role inference, routed principal and assigned-agent fallback. The shared logger handles provider callbacks, native session events, text, thinking, tools, results, and errors.
- Persistence: single-entry buffering, batch writes, JSONL serialization and reads, store events, and callback-based log sinks. Optional identity fields require no database migration.
- Transport: task and run SSE endpoints serialize the complete entry; task and multi-task log hooks preserve it. Reconnect/history reconciliation includes identity in duplicate detection. The global task notification feed carries only activity timestamps and is not a transcript source.
- UI: TaskChatTab and AgentLogViewer at desktop and mobile viewport widths; named, missing, blank, and duplicate-name identities; adjacent agents sharing the executor role. Existing empty-state behavior remains covered by component suites.

## Symptom Verification

- **Original symptom:** Coding (Kit Parity) activity displayed Reviewer even though the coding agent ran.
- **Exact reproduction:** Run the workflow-step principal test with Kit Parity Coder, Reviewer, and Tester identities and record an emitted session text event. Before the fix, the three new cases failed because entries had the hardcoded reviewer role and no agent identity.
- **Assertion it is gone:** Execution tests assert each entry's role, agent ID, and name. Persistence tests assert identical attribution in live events and reloaded history. React tests render the resulting entry shape and assert the Coder, Reviewer, and Tester labels, separate same-role/duplicate-name groups, and historical role fallbacks. Reconciliation tests assert that distinct agents' otherwise identical messages are retained.

## Browser acceptance

Playwright acceptance used the isolated Development Sandbox, with automation disabled. A workflow and task were created through the UI. The real AgentLogger and JSONL writer recorded synthetic Coder, Reviewer, and Tester output, including tool calls/results, two testers with the same name, and a historical entry without identity. The real task-log API and dashboard rendered those records at 1440px desktop and 390px mobile widths.

Checks covered Live and Raw views, tool-result expansion, reload and reopening the task, distinct duplicate-name groups, and legacy labels. A controlled SSE response separately verified that a new live coder entry retained its name in the real browser. External agent execution was not enabled in the preview; execution identity is covered by engine tests. Screenshots and the local acceptance scripts are saved under `output/playwright/` in the verification worktree.

The extended engine run also exposed two older tool-injection tests that lacked the workflow definition and routing roster required to reach an implementation session. Their fixtures now provide both through the existing routing-agent helper, preserving the assertions that completion remains mandatory and the removed review tool stays absent.
