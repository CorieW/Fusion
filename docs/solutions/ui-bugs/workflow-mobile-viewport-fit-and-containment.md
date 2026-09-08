---
category: ui-bugs
module: Dashboard workflow editor
tags: [workflow, mobile, react-flow, viewport, css]
problem_type: ui_bug
applies_when: Workflow nodes are clipped beneath graph controls or mobile navigation after resizing or opening a saved workflow.
---

# Workflow graph measurement and embedded containment

## Symptoms and causes

A saved copied workflow could leave its Start node above the mobile canvas, beneath the Graph/List control. Separately, mobile navigation covered nodes that were correctly centered inside an oversized embedded editor.

Three independent contracts were involved:

1. React Flow could perform initial fitting against zero viewport dimensions. The previous auto-fit helper waited for `useNodesInitialized()`, but this read-only controlled canvas does not echo dimensions through `onNodesChange`. Its cached initialization flag could remain false even after the internal node measurements existed.
2. The shared mobile `.modal:not(.confirm-dialog)` rule outranked the embedded editor's height rule. An editor inside a partial-height content pane became a full-viewport-height element.
3. In short panes, flex shrinking could leave no usable graph area below its controls.

## Resolution

`SimpleCanvasAutoFit` in `packages/dashboard/app/components/WorkflowSimpleCanvas.tsx` is the sole automatic fitter. It subscribes to the owning Flow store's real viewport dimensions and visible internal node bounds, avoids empty/unmeasured graphs, and cancels obsolete animation frames. No guessed settling timeout is needed.

`WorkflowNodeEditor.css` gives embedded sizing sufficient specificity against shared modal chrome and prevents the mobile editor stage from shrinking away its graph. The existing body scroller exposes overflowing content. Inspector detail stages still replace the canvas; dialog sizing is unchanged.

## Surface enumeration and verification

- Simple canvas: desktop and mobile, resize transitions, saved/copied graphs, measurement changes, empty/hidden nodes, and cancellation while hiding.
- Host geometry: embedded desktop, portrait/narrow/landscape mobile, plus the separate mobile dialog contract.
- Real preview: long copied workflow title, warning banners, desktop-to-mobile transitions, ordinary node clicks, and reachable inspector controls at 390×844 and 360×640.
- Existing workflow-editor interaction tests retain dirty-edit, duplication, permissions, and inspector coverage.

Fast controller coverage lives in `WorkflowSimpleCanvas.viewport.test.tsx`. The rendering-engine containment check is explicit opt-in and uses inline production CSS with every network request blocked:

```sh
node --test scripts/__tests__/workflow-viewport.browser.mjs
```

It requires an installed Chromium; set `FUSION_BROWSER_SMOKE_BROWSER` when discovery cannot find one. It starts no server and reads no project database. Missing Chromium is a failure, not a silently passing skip. Run the real preview separately when validating complete React Flow interactions; the CSS fixture deliberately does not pretend to cover them.
