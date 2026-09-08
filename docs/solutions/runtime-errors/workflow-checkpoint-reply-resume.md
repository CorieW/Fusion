---
title: Human checkpoint replies stranded in secondary work columns
date: 2026-09-08
category: runtime-errors
module: workflow-executor
problem_type: logic_error
tags: [workflow, ask-user, resume, lifecycle]
---

WORK-004 accepted a human `DONE` steering comment while in Testing, but the workflow never consumed it.
The workflow has three WIP columns: Coding, Review and Testing.

The update listener and deferred-unwind resume compared the current column with a singular WIP
destination. That destination names only the first WIP column. Resume eligibility now checks every
WIP column while leaving move destinations unchanged. Intake, terminal and unknown columns remain
ineligible; paused, user-paused, deleted and failed tasks remain protected.

A second defect cleared the `workflow-input` marker before the owning custom node could consume it.
Marker cleanup now applies to a different node; the owning ask-user/awaitInput or skill runner retains
its watermark and publishes the answer. Node IDs match exactly, so similarly prefixed checkpoints
cannot consume each other's input. Completed coding checklists do not skip a pending human checkpoint.
Replies arriving while the previous graph unwinds are deferred for a single resume.

## Surface Enumeration

- Default/renamed first WIP and secondary Review/Testing WIP columns; no-WIP and legacy workflow shapes.
- Immediate task-update dispatch and deferred session/graph teardown dispatch, with duplicate-run guards.
- `ask-user`, the `prompt` + `awaitInput` alias, and shared skill-marker handling, independent of provider.
- Missing/stale/malformed input dates, matching and similarly prefixed node IDs, fresh and non-DONE replies.
- Unfinished and completed coding checklists; user pause, engine pause, deletion and terminal failure.
- Workflow input submission and task comment plus explicit unpause use the same persisted steering input.
- Desktop/mobile reply UI; no UI affordance is added or removed.

## Symptom Verification

- **Original symptom:** a saved DONE reply leaves the task in Testing with its checkpoint marker intact.
- **Exact reproduction:** run a three-WIP-column graph to `human-completion`, persist a post-watermark
  DONE reply and clear the pause, then deliver the real task-update listener event.
- **Assertion it is gone:** the listener dispatches once, the real custom-node runner publishes
  `input:human-completion`, and the real graph's exit gate selects completion. A non-DONE response
  re-parks in place and a later DONE succeeds.

The regression is `packages/engine/src/__tests__/workflow-checkpoint-resume.test.ts`. It uses an
in-memory store and fake clock; no AI calls, GitHub mutations or real polling are needed.

## Validation

- 123 scoped engine tests, including real route/listener/graph integration and skill checkpoint handling.
- 118 dashboard component and route tests.
- 746 merge-gate tests, including 9 PostgreSQL transactional and lifecycle end-to-end tests on an owned test cluster.
- Workspace build, lint, typechecks, boot smoke and changeset validation.
- Playwright desktop (1280 × 900) and mobile (390 × 844): the actual reply component submits DONE
  and displays Resuming. API responses are simulated in this browser check because the isolated
  development preview disables task execution; backend behavior is asserted by the integration tests.

Production activation is separate from merging source. Existing stalled tasks need the fixed runtime
and an explicit resume. Editing a workflow definition alone does not retroactively execute a newly
inserted predecessor of the task's pinned checkpoint.
