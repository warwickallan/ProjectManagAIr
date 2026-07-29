# Project ManagAIr

Project ManagAIr is a reusable, AI-native project implementation operating
system. Its future Cockpit will provide a multi-project dashboard without
turning the product repository into a store for live project documents.

## Status

This repository is at the controlled-foundation stage. It contains policy and
architecture documents only. No application, integration, database, dashboard,
deployment, or live-data ingestion has been created.

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

Before implementation begins, Warwick must approve the open assumptions listed
in `GOAL-CONTRACT.md`, including the physical local-data root, initial
read/write posture, project identity model, and first implementation stack.

