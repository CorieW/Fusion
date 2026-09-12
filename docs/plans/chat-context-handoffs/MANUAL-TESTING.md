# Chat context and handoff acceptance

Tested on Windows on 2026-09-11, in `A:\kb-worktrees\chat-context-handoffs`.

The browser checks used the owned development preview and its synthetic project, separate home, and PostgreSQL cluster. The preview forbids agent execution; backend scenarios therefore used the production ChatManager with an in-memory store and scripted runtime sessions. No live model response was used as acceptance evidence.

## Browser checks

Chrome was exercised at 1440 × 1080 and 390 × 844. Fixtures contained a long review with findings at its end, 125 intervening messages, a quoted instruction, source-linked working notes, tool evidence, ordinary Markdown, an attachment, missing references, and malformed context metadata.

| Check | Result |
| --- | --- |
| Follow a quoted review outside the initial 50-message page | Source loads and scrolls to the transcript viewport; 131 distinct rows, no duplicates. |
| Follow working-note sources | Original instruction and review are reachable through their links. |
| Open context and working-note disclosures | Included/omitted counts and source-linked notes render correctly. |
| Follow a missing reference | Displays “The referenced message could not be loaded.” |
| Render malformed or empty context metadata | No empty disclosure appears. |
| Quote a reply with an existing draft | Source ID, author mention, original draft, and subsequent typed characters are preserved. |
| Search and switch conversations | Filtering and selection work. |
| Render existing message content | Ordinary bold text, tables, tool evidence, and attachment links remain present. |
| Mobile layout | No horizontal document overflow: document and viewport are both 390 pixels wide. |
| Browser console during the final interactions | No new errors. Preview startup separately logs denied provider-status requests. |

Screenshots and scenario logs are retained locally under `output/playwright/`; they are not release artifacts.

## Backend scenarios

Ten scripted scenarios exercised both session and room responders:

- Completed coder work releases the reviewer, whose prompt contains the persisted coder reply.
- Blocked work stops after the coder.
- A tool result after a completion report prevents the reviewer from starting.
- Coder → reviewer → coder preserves all three ordered steps.
- A review exceeding the prompt budget is explicitly deferred and its final findings remain recoverable through paged retrieval.

Every scenario recovered both findings. Normal-sized reviews reached the coder intact. An additional ordinary chat turn retained the preceding handoff context.

## Issues fixed during acceptance

1. User/system messages displayed generated quote references as literal Markdown. The shared renderer now recognizes scoped conversation links while preserving other plain text.
2. Inclusive history-page boundaries duplicated transcript rows. Pagination now skips displayed boundary rows, including tied timestamps, and merges overlapping responses by message ID.
3. Automatic bottom-follow frames could override a source jump after older history loaded. Explicit source navigation now takes viewport ownership before smooth scrolling emits its first event.
4. A bridge regression fixture used `deny`, which is not a valid policy disposition. It now uses `block` and continues to assert that board mutations are blocked while scoped conversation tools are allowed.

The UI regressions cover both viewport widths, overlapping concurrent pages, tied timestamps, and queued scroll frames. Existing streaming and latest-message behavior is included in the scroll regression suite.

## Known limitation found outside the change

Downloading the synthetic attachment returns HTTP 400, `Invalid attachment path`, on Windows. The existing attachment resolver compares Windows paths with a literal `/` suffix. The same code is present on `main` and this change does not modify it. Attachment link rendering passed; end-to-end attachment downloading did not.

Live provider execution and authentication were not tested because the isolated preview deliberately disables them.

## Automated regression checks

- 225 affected dashboard tests and seven Claude bridge tests passed.
- `pnpm test:gate` passed all 746 tests and 16 static validators against a disposable PostgreSQL 16 cluster on port 55708. The cluster was stopped and removed afterward.
- `pnpm lint` passed with no errors and five existing warnings.
- `pnpm verify:fast` passed all 35 steps, including typechecks, builds, and boot smoke with HTTP 200 from the isolated server on port 56090.

The development preview, browser session, and disposable gate database were shut down. The primary checkout remained on `main`.

Initial verification setup failures were corrected without changing assertions: the disposable database needed a host-only URL base and UTF-8 initialization; scratch browser scripts needed to stay outside the source lint scan. The bridge fixture type error described above was fixed in the change.

## Expanded acceptance — second pass

Further testing used the same isolated preview and new synthetic fixtures. It found one additional bug: a history request that remained pending in one conversation prevented source navigation in another conversation. The navigation lock now resets when the conversation changes and each request has its own identity, so a late completion cannot clear a newer request's lock.

The browser reproduced the failure with the first request deliberately held open: the second source remained unloaded. After the fix, both desktop and mobile reached the second source while the first request was still held. A deterministic regression failed at both widths before the fix and passed afterward; it also verifies that settling the old request does not start a duplicate request or report the new source as unavailable.

Additional checks passed:

- **Dense timestamp pagination:** a 280-message conversation contained 276 rows sharing a timestamp. Keyboard source navigation loaded every row exactly once at both viewport widths, through five history requests with offsets 47, 97, 147, 197, and 247. Jump-to-latest still worked.
- **Fetch recovery:** switching conversations during a delayed page did not leak transcript rows; an injected HTTP 500 produced feedback after one request; clicking the source again recovered all 131 rows. Draft text survived conversation changes. The injected HTTP 500 was the only console error during this scenario.
- **Real database retrieval:** literal search recovered all 275 matching messages across 14 result pages. Full Unicode message text and text attachments were reconstructed across ten pages each (119,017 characters); tool evidence required eleven pages (122,550 characters). The text-attachment retrieval tool worked independently of the existing Windows download-route failure.
- **Scope and notes:** foreign-conversation and foreign-project reads were rejected; accepted constraints without a user source were rejected; unresolved notes could not be archived; resolve-and-archive produced an empty checkpoint that stayed authoritative. Missing references remained explicit, and all three scoped context tools refused calls after the turn ended.
- **Ten additional handoff scenarios:** sessions and rooms each stopped dependent responders for a missing report, empty completion evidence, an unknown participant, a runtime failure, and failed reply persistence. Unknown participants prevented all responders from starting. Room failures returned the expected generation error.

Evidence is retained locally in `output/playwright/further-*.log`, the corresponding JSON result files, and desktop/mobile screenshots. Live providers remain outside the acceptance scope.

One mobile alignment poll reached the source but exceeded its eight-second measurement deadline. Its screenshot showed the source in view, and a rerun passed with the same deadline; no timeout or assertion was relaxed. The deterministic navigation and streaming regression suite passed all 30 tests after the fix.

Second-pass lint passed with the same five existing warnings. The merge gate passed all 746 tests and 16 static validators against a disposable PostgreSQL cluster on port 63318; that cluster was shut down and removed. The browser and development preview were also stopped, and the primary checkout remained on `main`.

Final `pnpm verify:fast` passed all 35 steps, including typechecks, builds, and boot smoke with HTTP 200 on isolated port 63638 and clean shutdown.

## Expanded acceptance — third pass

Rapid source changes exposed a second scroll race. The history loaded completely and the correct scroll action ran, but a delayed event at the old bottom position restored automatic following before smooth scrolling began. Browser instrumentation recorded the source jump followed by bottom-follow writes. The regression reproduced this at both viewport widths.

Explicit message navigation now moves immediately, changing viewport position and ownership together. This applies to source links and the existing message-top button. Their shared regression models the delayed scroll event and pending animation frames; all 32 navigation and streaming tests pass. The intentional behavior change is that these jumps no longer animate.

Further checks passed:

- **Newest source wins:** select a review source, hold its history request, then select the original instruction. After release, the instruction is aligned with the transcript viewport. Both widths retain 131 unique rows.
- **Leave and return:** hold a history request, select another conversation, then return and navigate again before the original request settles. The new navigation completes; releasing the older request preserves the source and all 131 unique rows. Both widths pass without new console errors.
- **Shared controls:** scroll through the long review, use its message-top button, and return with Latest. Both widths reach the intended positions without horizontal overflow.
- **Keyboard and dense pagination:** Enter on the source link loads all 280 unique messages through five history pages at both widths; Latest still reaches the bottom. This includes 276 rows sharing a timestamp.
- **Cancellation boundaries:** scripted production ChatManager sessions were stopped before and after reporting completion. In both cases the runtime was interrupted once, no reviewer started, late note/report calls were rejected, and only the visible prefix was durably saved as interrupted. Neither staged working notes nor a completion handoff was persisted. A second stop was an idle no-op.

The cancellation checks used scripted runtimes and an in-memory store; they do not establish live-provider interrupt behavior. Local evidence is retained in `output/playwright/third-*` logs, JSON results, and screenshots.

Lint passed with the same five existing warnings. The merge gate passed all 746 tests and 16 static validators against a disposable PostgreSQL cluster on port 51370; the cluster was shut down and removed. Browser scripts were synchronized with the rendered breakpoint after an initial resize detached the mobile Back button; no product timeout or assertion was weakened.

Final `pnpm verify:fast` passed all 26 steps, including typechecks, builds, and boot smoke with HTTP 200 on isolated port 51870 and clean shutdown. The browser and development preview were stopped; the primary checkout remained on `main`.

## Expanded acceptance — fourth pass, 2026-09-12

This pass exercised the unchanged implementation at `8c186e9b1` with new synthetic data in the owned development preview.

- **Replace a pending jump with a loaded source:** a 69-message fixture placed one source outside the first page and another inside it. With the older request held open, selecting the recent source navigated immediately. Both a successful response and an injected HTTP 500 preserved that selection at desktop and mobile widths. Each case made one history request, with no duplicate rows or obsolete unavailable-source warning. The two injected HTTP 500 responses were the only new console errors during these interactions.
- **Popped-out chat:** older history and working-note sources worked inside the floating window, retaining all 69 unique messages. Returning to the main Chat view retained working source navigation. The browser script initially matched both the visible main view and the hidden floating view; scoping the follow-up to the main view completed the check.
- **Narrow pop-out:** resizing with the window's actual handle produced a 358-pixel chat viewport with no horizontal overflow. Keyboard navigation loaded all 69 messages and left the main chat's scroll position unchanged.
- **Reload persistence:** after typing a quoted draft containing Unicode and additional text, reloading and reopening the conversation preserved the entire 289-character draft, source ID, context counts, working-note text, and navigable source links. The initial script expected automatic detail reopening; the existing list-first behavior requires selecting the conversation after a reload.
- **Storage rewind:** the real PostgreSQL store's message-rewind operation removed a later checkpoint and restored the earlier accepted working note. The deleted turn could no longer be read and appeared as an unavailable reference. This check covers transcript storage and context reconstruction, not provider session-file rewinding.
- **Deferred notes:** a 600-token context budget deferred a long working note, produced a 227-token context, and allowed the complete note to be recovered through `fn_chat_thread_read part=notes`.

Evidence is retained locally in `output/playwright/fourth-*` scripts, logs, JSON results, and screenshots. No application source or regression tests changed in this pass; the prior passing gate and build results still apply to the implementation. Live providers and the existing Windows attachment-download limitation remain outside these passing checks.

No additional defects were found in these acceptance checks. The browser and isolated preview were stopped, and the primary checkout remained on `main`.
