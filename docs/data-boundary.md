# Data Boundary

## Core rule

Project ManagAIr's Git history is a reusable product artifact, not a project
document store. If material is real, customer-specific, employer-specific,
secret, or operationally generated, it does not belong in Git.

## Data zones

| Zone | Examples | Authority | Git policy |
|---|---|---|---|
| Product repository | code, schemas, connector contracts, tests, docs, fictional fixtures | Git | Allowed |
| External project sources | NPL, NWLDC, and other live OneDrive or Google Drive folders | Source system | Forbidden |
| Local-only runtime state | configuration, cache, indexes, refresh cursors, derived projections, logs | Approved `C:\Brain\data` root | Forbidden |
| Read-only reference | `Vendor/mypka-reference` | Reference publisher/source | Forbidden |

The local workspace currently exposes `Data`, `ProjectManagAIr`, and
`Vendor/mypka-reference` as siblings. Keeping the product repository in the
`ProjectManagAIr` child makes the other two zones physically external to its
future Git root. Warwick must confirm the canonical physical path represented by
the intended `C:\Brain\data` policy before implementation hard-codes it.

## What may be committed

- provider-neutral domain and API schemas;
- connector interfaces and implementations with no live credentials or IDs;
- migrations for product-owned schemas, once approved;
- tests and test utilities;
- fictional fixtures clearly labelled as synthetic;
- documentation that describes classes of data without reproducing live
  content; and
- redacted examples that cannot be re-identified, when Warwick explicitly
  approves them.

## What must never be committed

- live project files, exports, attachments, emails, meeting records, or images;
- copied text, tables, metadata dumps, or embeddings from live project sources;
- customer, employer, employee, supplier, or stakeholder personal data;
- real tenant IDs, site IDs, drive IDs, folder IDs, document IDs, URLs, or
  filenames where those reveal project information;
- tokens, passwords, API keys, cookies, certificates, or connection strings;
- local databases, indexes, caches, logs, traces, prompt transcripts, or model
  outputs containing live content; and
- wholesale or runtime copies of myPKA reference material.

Project names mentioned in governance documents to define the boundary are not
test data and must not be expanded into project details.

## Original-source access

Each registered live source should eventually be represented by a local-only
configuration record containing only what is needed to resolve it. The working
agent must use that reference to read the original file through the authorized
source adapter or synced folder.

At minimum, derived observations should retain:

- project and source-system identity;
- stable source item ID or canonical path;
- source version or modified timestamp;
- observation timestamp;
- the agent or process that made the observation; and
- a distinction between quoted fact, structured extraction, and inference.

This provenance belongs in the appropriate external or local-only zone when it
identifies a live project. Only the reusable provenance schema belongs in Git.

## Derived data

A cache, index, embedding, normalized record, or dashboard projection of live
content remains live project data even when it is machine-generated. It must:

- stay outside Git under the approved local data root;
- be partitioned to prevent cross-project leakage;
- be deletable and rebuildable from authorized sources;
- have a defined retention policy;
- avoid storing more content than the use case requires; and
- never be treated as a substitute for checking the original source when an
  agent makes an implementation decision.

## Secrets and logging

Secrets should be resolved at runtime by reference from an approved secret
store or local-only configuration. Secret values must not enter source code,
agent briefs, committed fixtures, logs, exceptions, telemetry, or model output.

Logs should prefer opaque source IDs, operation names, timings, and result
counts. Logging original content or sensitive filenames is forbidden by
default.

## Controls to add before live-data use

These controls are proposed but deliberately not created in this milestone:

- repository secret and sensitive-data scanning;
- fixture provenance checks proving committed examples are synthetic;
- pre-commit and CI guards for prohibited paths and file types;
- connector permission and read-only enforcement tests;
- per-project cache isolation and deletion tests;
- audit-event redaction tests; and
- a documented incident response process for accidental Git ingestion.

If live data is ever found in Git, stop work, prevent further propagation, and
follow an approved history-remediation and credential-rotation process. Do not
attempt an ad hoc cleanup that leaves the material in repository history.

