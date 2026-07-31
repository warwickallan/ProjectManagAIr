# Project ManagAIr

Project ManagAIr is a reusable, AI-native project implementation operating system. Its Cockpit provides a local, read-only view of implementation projects without turning the product repository into a store for live project documents.

## Status

This repository contains the first local Cockpit MVP with a SQLite operational database. The included Atlas and Beacon data remains fictional demo material only; the default application state is the local database in the sibling Data folder.

## Repository Boundary

Git is for the reusable product:

- application and connector code;
- schemas and stable contracts;
- migrations and database adapters;
- automated tests;
- launcher scripts and documentation; and
- explicitly fictional fixtures.

Git is not for customer or employer project data. Live NPL, NWLDC, and other project documents remain in externally synced OneDrive or Google Drive project folders. Machine-local configuration, cache, indexes, portable runtimes, databases, WAL files, journals, imports, exports, and derived working state remain ignored and outside Git.

The sibling `Vendor/mypka-reference` folder is read-only architectural reference material. myPKA is neither Project ManagAIr's application repository nor its runtime data store. No myPKA source has been copied into this repository.

## Foundation Documents

- [GOAL-CONTRACT.md](GOAL-CONTRACT.md) defines the product goal and current delivery limits.
- [AGENTS.md](AGENTS.md) defines the rules for humans and AI agents working in this repository.
- [docs/architecture.md](docs/architecture.md) proposes the product's component boundaries.
- [docs/data-boundary.md](docs/data-boundary.md) defines what may cross into Git and what must remain external or local-only.
- [docs/sqlite-runtime.md](docs/sqlite-runtime.md) documents the local SQLite runtime and import path.
- [docs/m365-workday-cockpit.md](docs/m365-workday-cockpit.md) documents the Microsoft 365 workday Cockpit configuration and boundaries.
- [docs/extraction-skill-registry.md](docs/extraction-skill-registry.md) documents the versioned extraction skill registry and its promote/pin/rollback workflow.

## Extraction Skill Registry

The instructional text sent to the extraction model is versioned data, not code. Shipped seed
revisions live in `skills/<skillId>/<version>.md`; an organisation's private revisions live in the
directory named by `PROJECTMANAGAIR_SKILL_REGISTRY_DIR`, outside Git, and overlay or extend the
shipped set. Revisions are registered, promoted, pinned per project and rolled back through
`src/skillRegistry.ts`; every transition is explicit, attributed and audited, and the database
allows at most one active revision per skill id.

A skill revision can change what we ask the model for. It can never change what we accept back: the
packet schema, coverage, anchor and evidence rules, validation, reconciliation, human review and
deterministic replay stay in code and are unreachable from the registry. See
[docs/extraction-skill-registry.md](docs/extraction-skill-registry.md) for the workflow.

## Local Start

Do not install Node globally for this repository. The Windows launcher uses the ignored Project ManagAIr-owned portable runtime under `.runtime`.

Double-click:

`start-projectmanagair.bat`

or run:

```powershell
.\start-projectmanagair.ps1
```

The launcher creates or migrates `..\Data\projectmanagair.db`, starts the server on `127.0.0.1`, prefers port `4318`, and opens the Cockpit in the default browser.

## Import Structured JSON

```powershell
.\.runtime\node-v22.23.1-win-x64\node.exe --import tsx .\scripts\import-json.ts <path-to-structured-project.json>
```

The importer validates the payload, identifies the project by durable ID, upserts records by durable ID, records an import run, and stores source/provenance paths as external references. It does not copy source documents into Git or into the database.

## Validation

Use the copied portable runtime and local dependencies already present in the workspace:

```powershell
.\.runtime\node-v22.23.1-win-x64\npm.cmd test
.\.runtime\node-v22.23.1-win-x64\npm.cmd run build
.\.runtime\node-v22.23.1-win-x64\npm.cmd run test:e2e
```

Google Drive, OneDrive, SharePoint, Rocketlane, Dataverse, deployment, and writable Cockpit behavior remain separate future decisions.
