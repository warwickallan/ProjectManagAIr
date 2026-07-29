# Proposed Architecture

## Architectural intent

Project ManagAIr separates the reusable product from authoritative project
documents and from machine-local working state. The product should understand
many projects through explicit source adapters without absorbing live project
files into its repository.

The myPKA reference informed two general patterns: keep authoritative material
separate from derived views, and keep orchestration separate from specialist
execution. This document expresses those patterns as Project ManagAIr-owned
boundaries; it does not adopt myPKA as a dependency or datastore.

## Proposed layers

1. **Cockpit**
   - A future multi-project dashboard.
   - Presents project health, provenance, work queues, decisions, and
     exceptions.
   - Depends on application contracts, never directly on provider folders.

2. **Application services**
   - Coordinate project registration, source refresh, agent work, queries, and
     future commands.
   - Enforce authorization, data classification, provenance, and audit policy.
   - Keep provider-specific and UI-specific concerns outside the core.

3. **Project domain**
   - Provider-neutral definitions for project identity, source references,
     artifacts, work items, decisions, evidence, agent assignments, and status.
   - Stable schemas and invariants belong in the product repository.
   - Live artifact contents do not.

4. **Source and tool ports**
   - Interfaces for enumerating, reading, and resolving original sources.
   - Separate command ports may be added later for explicitly approved writes.
   - Working agents receive source references and read original content through
     these ports.

5. **Adapters**
   - Future OneDrive, Google Drive, and other provider implementations.
   - Normalize provider metadata while preserving original IDs, paths, URLs,
     versions, and timestamps.
   - Default to read-only and least privilege.

6. **Local runtime state**
   - Configuration, refresh cursors, caches, search indexes, derived
     projections, and product-owned operational state.
   - Lives beneath the approved local-only data root, outside Git.
   - Is partitioned by project and classification, with defined retention and
     deletion rules.

7. **External source systems**
   - OneDrive and Google Drive folders remain authoritative for NPL, NWLDC, and
     other live projects.
   - Source-system permissions remain the primary access boundary.

## Proposed information flow

```text
Externally synced project folder (authoritative)
                    |
                    v
        Read-only source adapter
                    |
                    v
    Provenance-preserving normalization
             |                 |
             v                 v
  Disposable local        Original-source
  projection/cache        reference for agent
             |                 |
             +--------+--------+
                      v
             Application services
                      |
                      v
          Cockpit and agent work queues
```

The normal read path never copies live project content into Git. A working agent
uses the original-source reference to inspect the authoritative document
directly. Any local projection is an optimization, not evidence that replaces
the source.

## Orchestration boundary

Larry is a control-plane role:

- understand the requested outcome;
- select and brief a capable working agent;
- pass source locations, identifiers, constraints, and acceptance criteria;
- track progress and synthesize results.

The working agent is the evidence-plane role:

- open the original project sources directly;
- distinguish source facts from inference;
- retain provenance in outputs;
- report access gaps rather than filling them with guesses.

Larry must not transform live project material into a paraphrased substitute
for direct source access.

## Future command boundary

Reading and writing are separate capabilities. A later write-back feature
should require:

- an explicit command interface rather than a hidden side effect of a query;
- source-specific authorization and least-privilege scopes;
- validation and a human approval gate where risk warrants it;
- idempotency or conflict detection;
- an audit record that excludes secrets and unnecessary source content; and
- a clear recovery or reconciliation path.

No write-back capability is approved or implemented at this milestone.

## Decisions intentionally deferred

- programming language, framework, and monorepo shape;
- database or search technology;
- connector SDKs and authentication flows;
- deployment topology and tenancy model;
- Cockpit UI design;
- detailed domain schemas;
- agent runtime and scheduling model; and
- Power Platform or Dataverse involvement.

