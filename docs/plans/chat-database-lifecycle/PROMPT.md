# Keep chat available across engine pause and restart

## Original Description

Chat displayed a failed session query after the project was paused. Restarting Fusion restored access.
The operator requested a permanent fix so another pause would not require a dashboard restart.

## What This Delivers

Conversations remain usable after pausing or restarting project automation. Live updates reconnect
automatically, and ongoing conversations retain their generation and cancellation state.

## Before → After Transformation

Before: project-path caches retain services using a closed engine database pool; event streams
repeatedly poll that ended pool. After: persistence bindings follow the current project store,
closed launch stores resolve to a dashboard-owned replacement, and old event streams reconnect.

## Context

The production log recorded project pause followed immediately by `CONNECTION_ENDED` failures.
`TaskStore.closing` already marks backend shutdown. Chat caches currently identify a project only
by its folder, even though its engine and dashboard can own different database layers over time.

## Surface Enumeration

- Shared backend lookup before every model provider and CLI bridge; direct and task-planner chats,
  session creation/read, room persistence, model sends, CLI sends, stream/cancel generation ownership.
- Desktop, mobile and Quick Chat use the same server stores and managers; no UI layout changes.
- Registered launch and secondary projects; live engine, draining engine, paused/absent engine,
  replacement engine, repeated replacement, same store with a replacement layer.
- Missing and populated sessions; repeated lookups; separate projects; matching engine ChatStore
  adoption for memory capture; absent and replacement plugin/message services.
- Existing SSE streams before/after initial cursor seed, pending reads at shutdown, transient
  failures, cleanup of listeners/timers and reconnection through canonical project resolution.

## Steps

1. Bind cached ChatStores to the owning store and layer and refresh ChatManager persistence together.
2. Preserve generation state and CLI routing while releasing obsolete auxiliary services.
3. Replace closing stores in shared API/realtime resolution and end obsolete event streams.
4. Reproduce the failure with closed-handle fakes; run affected tests, lint, typecheck/build and gate.

## Symptom Verification

- **Original symptom:** a chat send fails loading its session with `CONNECTION_ENDED` after engine pause.
- **Exact reproduction:** create cached chat services, complete a send, close the old backend handle,
  resolve a replacement store at the same project folder, and send again. Repeat after another replacement.
- **Assertion it is gone:** session reads, creation and sends use the replacement handle successfully;
  active generation identity survives; closing stores are never returned by API/realtime resolution;
  event streams end and stop querying the old handle.

## File Scope

- packages/dashboard/src/chat-project-services.ts
- packages/dashboard/src/chat.ts
- packages/dashboard/src/routes/context.ts
- packages/dashboard/src/routes/register-chat-routes.ts
- packages/dashboard/src/server.ts
- packages/dashboard/src/sse.ts
- packages/dashboard/src/__tests__/chat-project-services.test.ts
- packages/dashboard/src/__tests__/chat-manager.test.ts
- packages/dashboard/src/__tests__/chat-manager-cli-send.test.ts
- packages/dashboard/src/__tests__/routes-chat-cancellation.test.ts
- packages/dashboard/src/__tests__/routes-context-project-identity.test.ts
- packages/dashboard/src/__tests__/sse-agent-activity.test.ts
- .changeset/chat-database-lifecycle.md
- docs/plans/chat-database-lifecycle/PROMPT.md

## Deployment

Build and verify in the isolated worktree. Production activation remains an operator handoff.

## Validation

- Original cache implementation: both repeated-replacement send regressions fail with `write CONNECTION_ENDED`.
- Fixed implementation: 193 tests passed across the final chat, cancellation, SSE and resolution run;
  the final launch-resolution adjustment passed its 17-test resolution/cancellation run.
- The earlier six-file run passed all 182 tests, including the real PostgreSQL SSE integration test.
- `pnpm test:gate`: 746 tests passed and all 16 static validators passed.
- `pnpm verify:fast`: typechecks, builds and boot smoke passed. Workspace dependency links were then
  localized to this worktree; the CLI was rebuilt, its new persistence/reconnect code was confirmed
  in the executable, and a fresh boot smoke passed against that executable.
- Final server typecheck and scoped lint passed. The chat registrar retains two pre-existing
  control-character regex warnings; no lint errors were introduced.
- All database tests used a dedicated local test cluster after correcting the default test URL.
  That cluster was stopped after verification. Production was not activated or restarted for this fix.
