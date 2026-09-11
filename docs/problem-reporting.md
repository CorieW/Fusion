# Structured problem reporting

Testing workflows can opt into `fn_problem_report`. This grants permission to report demonstrated defects within the current task's project and workflow. It does not enable ordinary task creation, delegation or refinement during board execution.

Add this declaration to the workflow's v2 IR, using your actual column IDs:

```json
{
  "problemReporting": {
    "sourceColumns": ["testing", "testing-parity"],
    "openColumn": "problems",
    "resolvedColumn": "resolved-problems"
  },
  "fields": [
    { "id": "record_type", "name": "Record type", "type": "text" },
    { "id": "problem_type", "name": "Problem type", "type": "text" },
    { "id": "kit_path", "name": "Kit path", "type": "text" },
    { "id": "extension_path", "name": "Extension path", "type": "text" },
    { "id": "originating_task_id", "name": "Originating testing task", "type": "text" }
  ]
}
```

All referenced columns must exist. Reporting columns cannot also be source columns. Import rejects missing or incompatible field declarations. String, text and compatible enum fields are supported. Additional declared custom fields can be supplied in `report.customFields`; unknown fields are rejected. Evidence, reproduction, configuration and paired observations are persisted with each report and available through the tool's `read` action. The source task ID is filled from trusted session context.

Each authorized implementation or workflow-step session starts a fresh results ledger before its model runs. The same tool is exposed through the engine's provider bridges and CLI extension, including explicitly authorized read-only testing steps. Unconfigured sessions can inspect capability availability; writes remain refused.

The workflow grant is the reporting authority; general task-creation permission does not enable or disable it. The engine passes a reporting generation through both tool paths. Expired generations and sessions whose source moves to another column or workflow cannot use a replacement ledger. Switching workflows starts a separate ledger.

## Reporting sequence

1. Call `{"action":"preflight"}` before expensive testing. Check `available` and the designated columns.
2. As demonstrated findings become known, declare their stable request IDs with `{"action":"expect","requestIds":["null-property-1"]}`. Repeated calls add requirements.
3. Persist each report:

```json
{
  "action": "report",
  "report": {
    "requestId": "null-property-1",
    "problemKey": "firestore-export-drops-null-property",
    "problemType": "parity",
    "title": "The kit drops null properties during export",
    "kitPath": "kits/firestore-export",
    "extensionPath": "extensions/firestore-export",
    "reproduction": "Export a document containing {\"value\":null} and compare outputs.",
    "configuration": "Local emulators, default configuration",
    "evidence": ["Extension output: {\"value\":null}; kit output: {}"],
    "extensionObservation": "The null property is retained.",
    "kitObservation": "The null property is absent."
  }
}
```

4. Record `createdTaskId`, `survivingTaskId`, `matchedResolvedTaskId` and `deletedTaskIds` from the receipt. Read the survivor with `{"action":"read","id":"<survivingTaskId>"}`. Follow `nextObservationOffset` until it is null to inspect all retained evidence.
5. Call `{"action":"finish","requestIds":["null-property-1"]}` with every expected and reported finding. Use an explicit empty array when there were no findings. Missing receipts or live survivors prevent success; completion rechecks the persisted ledger. Report attempts register their request IDs before writing, so a rejected write remains pending. A report after `finish` invalidates that finish and requires another final check. Retries retain the same stage's earlier requirements and receipts.

The ledger verifies the findings the workflow declares. It cannot infer undisclosed defects from free-form model output; testing prompts must require declaration of every demonstrated finding. Candidate mismatches should be investigated before being reported as demonstrated defects.

## Deduplication and retries

`problemKey` is an explicit identity for the underlying defect, not a fuzzy title match. Use the same key for the same cause and different keys for different causes. Identity also includes `problemType`, `kitPath` and `extensionPath`, so general and parity reports never merge. Existing records must carry the reporting tool's identity metadata to participate in automatic deduplication; records without that identity still appear in column enumeration for inspection.

Resolved matches take precedence. The incoming task is created and soft-deleted atomically; the resolved record and any existing open duplicates remain unchanged. Otherwise the newly accepted report survives, older open duplicates are soft-deleted, and their observations and missing custom fields are copied into the survivor. Conflicting older values, descriptions, comments and attachment references remain available in retained observations. Soft-deletion preserves forensic rows and emits the normal durable deletion event.

Use the same `requestId` and identical payload when retrying after a timeout or lost response. A changed payload with a reused request ID is rejected; report added evidence with a new request ID and the same problem key. Request identity is scoped to the parent task and workflow. Receipts follow supersession chains when a later report replaces their survivor.

All report writes, evidence merging, workflow membership, deletion events and parent receipts share a PostgreSQL transaction and project/workflow lock. A failed transaction leaves none of its partial mutations behind. Concurrent reports serialize, and committed retries do not create additional records. Report IDs use a separate deterministic `PRB-` namespace.

New records are paused, user-held and have auto-merge disabled. A human must explicitly release or resolve them.

## Enumeration

`{"action":"list","column":"resolved-problems"}` enumerates that column; omit `column` to enumerate both. Continue with `after` set to `nextCursor` until it is null. Pages contain at most 25 IDs and summaries. Custom terminal columns are included. Reads and enumeration cannot cross the authorized project/workflow or designated columns.

`fn_task_list` also accepts arbitrary workflow column IDs. Engine pagination uses `after` / `nextCursor`; CLI grouped pagination uses `after` / `nextCursorByColumn[column]`. For a complete problem inventory, prefer the dedicated tool's scoped list action.

Large evidence observations return `contentPart` instead of the full object. Continue with `contentOffset: nextContentOffset` and the returned `contentHash` until `nextContentOffset` is null. Concatenate the parts and parse the resulting JSON, then continue observation pagination. The hash prevents combining evidence from different revisions during concurrent updates.

Reads include `currentRecord` with human-added description, comments and attachment references, including for older records without reporting metadata. Generated descriptions are represented by their structured observations instead of repeated on every page. Required custom fields are checked after retaining older values and applying defaults; explicit null cannot bypass a required value.

## Surface enumeration and symptom verification

- Engine implementation sessions, workflow prompt/skill sessions (including read-only testing), step sessions and CLI extension share the reporting service/schema.
- Import validation and session preflight reject unavailable capabilities before testing. Completion and session exits verify the results ledger.
- Tests cover empty/populated/multiple pages, both problem types, both columns, distinct causes and paths, project/workflow isolation, source provenance, missing/unknown fields, missing parity pairs, stale sessions, retries, concurrent reports, rollback, retained evidence and resolved precedence.
- Original symptom: demonstrated findings could not be persisted during board execution. The PostgreSQL regression creates a declared testing workflow and parent task, reports a finding, reads all fields/evidence back, and proves incomplete ledgers cannot succeed.

No dashboard affordance changes are needed: records use existing task cards and declared-field rendering at every breakpoint.
