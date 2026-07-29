# Project ManagAIr

Project ManagAIr is a reusable, AI-native project implementation operating
system. Its future Cockpit will provide a multi-project dashboard without
turning the product repository into a store for live project documents.

## Status

This repository contains the first local, read-only fictional-data MVP: a
multi-project Cockpit for Project Atlas and Project Beacon. It includes no live
integration, database, deployment, or live-data ingestion.

## Repository boundary

Git is for the reusable product:

- application and connector code;
- schemas and stable contracts;
- automated tests;
- documentation; and
- explicitly fictional fixtures.

Git is not for customer or employer project data. Live NPL, NWLDC, and other
project documents remain in their externally synced OneDrive or Google Drive
project folders. Machine-local configuration, cache, indexes, and derived
working state belong outside the repository under the approved local data root
(intended to be `C:\Brain\data`) and must remain ignored.

The sibling `Vendor/mypka-reference` folder was inspected as read-only
architectural reference material. myPKA is neither Project ManagAIr's
application repository nor its runtime data store. No myPKA source has been
copied into this repository.

## Foundation documents

- [GOAL-CONTRACT.md](GOAL-CONTRACT.md) defines the product goal and current
  delivery limits.
- [AGENTS.md](AGENTS.md) defines the rules for humans and AI agents working in
  this repository.
- [docs/architecture.md](docs/architecture.md) proposes the product's
  component boundaries.
- [docs/data-boundary.md](docs/data-boundary.md) defines what may cross into
  Git and what must remain external or local-only.

## Next decision gate

Warwick should manually review the fictional-data MVP before this build branch
is considered for merge. Live connectors, writable behaviour, databases, and
deployment remain separate future decisions.

## Run the fictional-data MVP

Requirements: Node.js 22 or later and npm.

```powershell
npm install
npm run dev
```

Open `http://127.0.0.1:4318`. The server binds to loopback, reads only
`fixtures/portfolio.json`, and exposes GET-only APIs. The visible `Needs
Warwick` label comes from the fictional demo display configuration; reusable
attention logic remains person-neutral and falls back to `Needs You`.

Validation commands:

```powershell
npm test
npm run build
npm run test:e2e
```

Use `npm start` after `npm run build` to serve the production build locally.
No connector, database, secret, or live project source is required.
