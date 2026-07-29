# Goal Contract

## Product

**Name:** Project ManagAIr

**Purpose:** A reusable, AI-native project implementation operating system that
helps working agents understand and implement multiple projects from their
original source material. Its future Cockpit will provide a multi-project
dashboard.

## Product outcome

Project ManagAIr should eventually:

- register multiple projects without ingesting their live documents into Git;
- give agents governed access to each project's original source folders;
- normalize source metadata behind stable, provider-neutral contracts;
- coordinate implementation work while preserving source provenance;
- expose project state and actionable exceptions through a Cockpit; and
- remain reusable across customers, employers, storage providers, and project
  types.

## Invariants

1. Git contains the reusable product, code, schemas, connectors, tests,
   documentation, and fictional fixtures only.
2. Real customer and employer project data never enters Git.
3. NPL, NWLDC, and all other live project documents remain in their externally
   synced OneDrive or Google Drive folders.
4. Local configuration, cache, indexes, and derived runtime state live under an
   approved local-only data root and remain ignored by Git.
5. myPKA is reference material, not the application repository or runtime data
   store.
6. Larry may orchestrate, but the working agent reads original sources directly
   and does not rely on Larry's paraphrase as evidence.
7. Derived data is traceable to its source and can be deleted and rebuilt
   without loss of the authoritative documents.
8. Any write to an external source is explicit, least-privileged, auditable,
   and separately approved.

## Current milestone

Create only the controlled repository foundation:

- `README.md`
- `AGENTS.md`
- `GOAL-CONTRACT.md`
- `.gitignore`
- `docs/architecture.md`
- `docs/data-boundary.md`

This milestone does not authorize Git initialization, application scaffolding,
features, integrations, databases, dashboards, Power Platform, Dataverse, or
deployment.

## Approval required before implementation

Warwick must approve:

- the physical repository root and the canonical physical local-data root;
- the first project identity and source-registration contract;
- whether the first release is read-only or includes narrowly scoped write-back;
- the first connector/provider and its permission model;
- the application stack and supported host environments;
- the persistence strategy for disposable projections and product-owned state;
- the security, retention, deletion, and audit requirements;
- the Cockpit's initial audience and authentication boundary; and
- product licensing and the acceptable level of reuse from reference material.

## Acceptance criteria for this milestone

- Exactly the six requested files exist in the product folder.
- The data boundary is explicit and consistent across all six files.
- No real project data or reference-source copy is present.
- No runtime, dependency, integration, database, or deployment artifact exists.
- The unresolved implementation decisions remain visible as approval gates.

