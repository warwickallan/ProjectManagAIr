# SQLite Operational Runtime

Project ManagAIr now uses a local SQLite database as the default operational state for the Cockpit.

## Runtime

The Windows launcher expects a local, ignored portable Node runtime at:

`<workspace-root>\ProjectManagAIr\.runtime\<node-runtime>`

This folder is copied locally from the proven myPKA runtime. It is not installed, is not committed, and must not be treated as a product dependency source in Git.

## Database

The live SQLite database is resolved from the repository to the sibling Data folder:

`<workspace-root>\Data\projectmanagair.db`

`<workspace-root>` is the local workspace folder holding the `ProjectManagAIr`, `Data` and `Vendor` siblings. Its physical path is local-only configuration and is deliberately not committed; see `docs/data-boundary.md`.

The database, WAL files, journals, imports, exports, runtime binaries, and local configuration remain outside Git.

## Local Start

Double-click:

`start-projectmanagair.bat`

or run:

```powershell
.\start-projectmanagair.ps1
```

The launcher uses the Project ManagAIr-owned portable runtime, adjusts PATH only for its own process, applies migrations, starts the local server on `127.0.0.1`, and opens the Cockpit. It prefers port `4318` and chooses a nearby free loopback port if that port is occupied.

## Importing Structured JSON

The importer accepts validated JSON containing one project and writes it transactionally into SQLite:

```powershell
.\.runtime\<node-runtime>\node.exe --import tsx .\scripts\import-json.ts <path-to-structured-project.json>
```

The importer uses durable IDs for upserts, records an import run, stores provenance and external file paths as references, and does not copy source documents into the database or repository.

Google Drive, OneDrive, SharePoint, Rocketlane, Dataverse and other live connectors are deliberately not implemented yet.
