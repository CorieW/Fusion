# Windows static merge-gate execution

The static gate entry point compared `import.meta.url` with a hand-built `file://` string. Windows drive letters, backslashes, and escaped spaces made those strings differ, so invoking the CLI could exit successfully without running validators. Resolve the argument and use `pathToFileURL` before comparison.

The capacity validator used a shell command with single-quoted Git pathspecs. Windows command parsing passed the quotes to Git, producing an empty file list. Use `execFileSync` with an argument array so Git receives the same pathspecs on every platform.

## Surface Enumeration

The gate module supports imported use and direct CLI execution. Both must run every requested validator and propagate failures. Git enumeration must inspect tracked TypeScript sources, retain existing test-file exclusions, and work from paths containing spaces.

## Symptom Verification

- **Original symptom:** On Windows the gate runner silently skipped its validators, while direct capacity validation refused an empty file list.
- **Exact reproduction:** Invoke the gate CLI from a temporary fixture directory containing spaces and an observable validator; invoke the capacity CLI against a temporary Git repository with one tracked TypeScript file.
- **Assertion it is gone:** The CLI regression observes validator output and rejects a failing validator. The capacity regression reports one inspected file. The normal merge gate runs the complete validator inventory before its test lanes.

Regression tests live in `scripts/__tests__/run-static-gate-checks.test.mjs`. The inventory assertion also includes the existing no-comment-assertions validator, which the previous test mirror omitted.
