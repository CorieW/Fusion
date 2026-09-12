# Reliable chat context and agent handoffs

## Original Description

An agent asked to fix two findings could not see them because the preceding review was cut off. Replace this with a shared conversation and reliable handoffs, in an isolated worktree.

## What This Delivers

Agents can read the conversation they join, retain important decisions, and pass completed work to the next participant. Operators can see when history was omitted or a handoff stopped.

## Before → After Transformation

Fixed per-message truncation and inaccessible history become complete messages selected within a model-aware token budget, recoverable omissions, source-linked notes, and completion-gated ordered replies.

## File Scope

- docs/plans/chat-context-handoffs/MANUAL-TESTING.md (new)
- packages/dashboard/src/chat.ts
- packages/dashboard/src/chat-thread-context.ts (new)
- packages/dashboard/src/chat-thread-tools.ts (new)
- packages/dashboard/src/chat-handoff.ts (new)
- packages/dashboard/src/chat-attachment-content.ts
- packages/dashboard/src/__tests__/chat-*.test.ts
- packages/dashboard/app/components/StandardChatSurface.tsx
- packages/dashboard/app/components/ChatContextDisclosure.tsx (new)
- packages/dashboard/app/components/ChatContextDisclosure.css (new)
- packages/dashboard/app/components/ChatView.tsx
- packages/dashboard/app/hooks/useChatReferenceNavigation.ts (new)
- packages/dashboard/app/hooks/useChat.ts
- packages/dashboard/app/hooks/__tests__/useChat.test.ts
- packages/dashboard/app/hooks/__tests__/useChatReferenceNavigation.test.tsx (new)
- packages/dashboard/app/components/__tests__/*Chat*.test.tsx
- packages/dashboard/app/utils/chatQuotePrefill.ts
- packages/dashboard/app/utils/chatQuotePrefill.test.ts
- packages/engine/src/execution/gating-classifications.ts
- packages/engine/src/__tests__/gating-classifications.test.ts
- plugins/fusion-plugin-claude-runtime/src/tool-bridge.ts
- plugins/fusion-plugin-claude-runtime/src/__tests__/tool-bridge.test.ts
- packages/i18n/locales/*/app.json
- packages/i18n/src/resources.d.ts
- docs/dashboard-guide.md
- .changeset/chat-context-handoffs.md (new)

## Surface Enumeration

- Direct @mentions and room direct/ambient responders; shared native and CLI-provider session resolver; both permanent-agent and action gates; ordinary Direct/Quick Chat retrieval and handoff continuity. Raw terminal executor sessions retain terminal-owned input semantics.
- Desktop and mobile use the shared message renderer; context disclosure uses existing typography, spacing, and disclosure primitives.
- Empty, undefined, duplicate, populated, long, oversized, and older-than-fetch-window messages; Unicode; missing/deleted and foreign-conversation references; attachments and tool evidence.
- Quote prefill, context builder, scoped retrieval, persisted working notes, sequential handoffs, runtime errors, absent completion reports, cancellation, and persistence failures.
- Historical and empty note checkpoints beyond the initial fetch; repeated participants; reports concurrent with tools; native and ACP tool-result correlation, changing display titles, delayed start notifications; stalled source pagination and conversation switches; Claude bridge authorization.
- Plain-text user/system quote references, overlapping history pages, simultaneous page requests, and inclusive timestamp boundaries containing multiple messages.
- Source jumps during queued bottom-follow animation frames, alongside ordinary streaming and jump-to-latest behavior.
- A stalled history request in a previous conversation, navigation in the newly selected conversation before that request settles, and late completions that must not clear another request's lock.
- Rapid source changes within one conversation, leaving and returning while a page remains pending, and delayed bottom-position events during explicit navigation. Cover source links and the shared message-top button at desktop and mobile widths, plus keyboard navigation and return-to-latest behavior.
- Replacement of a pending older-source jump with an already-loaded source, successful and failed late responses, wide and narrow floating hosts, reload/reopen persistence, and working-note reconstruction after transcript rewind.
- No task lifecycle changes or production process changes.

## Symptom Verification

- **Original symptom:** findings at the end of the immediately preceding review disappear when a coder is mentioned.
- **Exact reproduction:** persist a review substantially longer than 1,200 characters, ending with two actionable findings; mention a coder to fix both, then a reviewer to check the result.
- **Assertion it is gone:** inspect the actual generated coder/reviewer prompts and assert that both findings survive, the reviewer sees the persisted coder result, omitted history is retrievable, and failed/blocked/unreported work cannot trigger a dependent review.

## Verification

Run the affected dashboard unit/integration tests, lint, typecheck/build/boot smoke, and the repository merge gate. Tests use in-memory stores and fake runtime sessions, without real model calls.

### Implementation verification — 2026-09-11

- Original symptom reproduced through the actual responder prompt assembly for session and room responders, with both native and CLI runtime adapters mocked. Complete findings and the persisted predecessor result reach the next participant.
- Targeted context, retrieval, handoff, manager, cancellation, attachment, quote, navigation, disclosure, and tool-gate tests passed. Coverage includes the missing report, blocked work, failure, and late-tool-work cases that must stop a dependent responder.
- Lint passed with five existing warnings; dashboard typechecks and scoped lint passed after the final edits.
- `pnpm test:gate` passed: 16 static validators and 746 tests across engine, core unit, PostgreSQL, and CI-shape suites. Windows required Git Bash as the temporary script shell and a disposable PostgreSQL 16 cluster on port 63240; the cluster was stopped afterward. The default local database login failed before test setup and was not modified.
- Final `pnpm verify:fast` passed all 32 steps, including package typechecks/builds, the CLI build, and boot smoke against an isolated home on free port 63503.

### Scope and limits

- Token capacity is estimated. Whole messages that exceed the prompt budget remain available through paged retrieval; the model receives an explicit instruction to read required omissions.
- Working notes are agent-maintained interpretations, saved with successful replies and linked to original messages. They do not establish user approval by themselves.
- A completion report releases the next participant; its evidence remains a claim for the reviewer to verify. Sequence recognition supports the documented explicit English forms such as `Then @Reviewer`.
- No real provider calls, production activation, merge, or release are part of this change.

### Follow-up review and fixes

Five passes covered context persistence, handoff scheduling, tool completion, UI navigation, and provider integration. The review found and fixed:

- Older working-note checkpoints were lost outside the fetch window. The loader now finds the latest checkpoint, including an empty checkpoint that must not resurrect archived notes. Normal replies persist empty checkpoints too, avoiding repeated historical scans.
- Returning to the main chat model omitted the instruction behind an agent's reply. Both the request and its dependent replies now receive context priority, including requests outside the recent window.
- Omission notices could overflow the token budget. Their actual overhead is reserved and long ID lists are bounded while full IDs remain in the context report.
- Repeated agents in an ordered sequence were deduplicated. Each mention now creates its own step with an explicit step number.
- A report could precede outstanding tool completion. Reports now require settled tools and correlate their result using a receipt, covering arbitrary runtime titles and delayed start notifications. Later tool results invalidate an earlier report.
- Source navigation retried pages that made no progress. It now stops with feedback and cancels when the conversation changes, while progressing searches can reach sources beyond the former 50-page limit.
- Claude's custom-tool bridge classified scoped conversation coordination as board mutation. The four conversation tools are exempt from mutation approval, while authentication, policy-presence checks, and mutation gating remain enforced.

Regression cases reproduce the original failures through shared session/room prompt assembly, tool execution and runtime callbacks, source pagination, and the bridge's permission classifier. Runtime calls remain mocked; no model-provider request is made by these tests.

Follow-up validation: 247 dashboard regression tests and seven Claude bridge tests passed; the 746-test merge gate passed against a disposable PostgreSQL cluster. `pnpm verify:fast` passed all 33 steps, including boot smoke on port 61000. Lint passed with the same five existing warnings. One handoff-only runner exited with Windows access-violation code `3221225477` after all 33 assertions passed; an unchanged rerun passed with exit code zero. No test assertions or timeouts were weakened. Temporary database and log artifacts were removed after verification.

### Manual acceptance and fixes

See [MANUAL-TESTING.md](MANUAL-TESTING.md) for desktop/mobile browser checks, ten scripted session/room handoff scenarios, and the existing Windows attachment-download limitation. Acceptance found and fixed plain-text quote links, duplicate history pages, and automatic scrolling that could override a source jump. It also corrected an invalid permission-policy value in a bridge regression fixture. The isolated preview and synthetic data were used throughout; production was not restarted.
