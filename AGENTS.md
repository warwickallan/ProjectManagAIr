# Working Agreement for Agents

These instructions apply to every human or AI agent working in this repository.

## Start here

Before changing the repository:

1. Read `GOAL-CONTRACT.md`.
2. Read `docs/architecture.md`.
3. Read `docs/data-boundary.md`.
4. Inspect the original project sources relevant to the assigned work.

If a request conflicts with these documents, stop and ask Warwick rather than
silently weakening a boundary.

## Product and data boundary

The repository may contain only reusable product material: application code,
schemas, connector implementations, tests, documentation, and fictional
fixtures.

Never commit, stage, paste into tracked files, or use as test fixtures:

- real customer or employer project documents;
- extracts or paraphrased payloads that preserve sensitive project facts;
- credentials, tokens, cookies, connection strings, or personal identifiers;
- local caches, indexes, databases, logs, exports, or generated source mirrors;
  or
- contents copied wholesale from an external source or reference folder.

Treat the approved `C:\Brain\data` location as local-only configuration and
cache. The actual physical path must be confirmed before code relies on it.
Repository-local `data/`, databases, environment files, and common generated
state are ignored as a second line of defence.

## Original-source rule

Larry may orchestrate development by selecting an agent, setting the objective,
and pointing to relevant sources. Larry must not become a paraphrased data
relay.

The working agent must read the original project sources directly from the
configured OneDrive or Google Drive project folder. Its output must retain
source provenance sufficient to distinguish an original fact from an
inference. If direct source access is unavailable, the agent must report that
constraint and stop any work that would otherwise require guessing.

## Reference-material rule

`../Vendor/mypka-reference` is read-only architectural reference material.
Do not modify it, initialise Git inside it, import it as a runtime dependency,
use it as Project ManagAIr's datastore, or copy it wholesale. Reuse concepts
only after expressing them as Project ManagAIr-owned contracts and checking any
licensing implications before copying code or text.

## Implementation rules

- Keep adapters at the boundary of external systems; do not leak provider
  formats into the core project model.
- Treat external project folders as authoritative for live documents.
- Treat caches and projections as derived, disposable, and rebuildable.
- Default new integrations to disabled and least privilege.
- Keep secrets by reference and out of logs, prompts, fixtures, and Git.
- Use synthetic names and contents for every committed fixture.
- Preserve source identity and provenance through normalization.
- Fail closed when data classification, source ownership, or write authority is
  unclear.
- Do not add a write-back path to a source system without explicit Warwick
  approval and an auditable command boundary.

## Multi-agent delivery and review workflow

The main Codex session owns implementation. Independent investigation and
review should be delegated to focused read-only reviewers when that is useful
for quality or responsiveness.

Workflow:

1. The main agent owns implementation.
2. Independent investigation and review should be delegated.
3. Read-heavy reviewers may run in parallel.
4. Only one implementation agent writes to a working tree at a time.
5. Reviewers never repair their own findings.
6. The main agent decides whether findings are genuine.
7. Only genuine blockers are fixed.
8. Relevant reviewers re-check the repaired exact head.
9. Release Gate runs last against the exact pushed SHA.
10. No merge occurs without an APPROVE verdict.
11. Once APPROVE is issued, stop building.
12. Further polish requires a new approved goal.

Keep the system lightweight:

- Run a maximum of three reviewer agents concurrently.
- Run Release Gate only after the specialist reviews finish.
- Do not run every reviewer for every change.
- Do not repeat broad test suites unnecessarily.
- Delegate bounded investigations so the main agent remains responsive.
- Review agents return concise findings, not long activity logs.

Future routing:

- UI work: `ui-reviewer` and `qa-reviewer`.
- SQLite/import work: `schema-reviewer` and `qa-reviewer`.
- Microsoft/external integration work: `research-reviewer` and `qa-reviewer`.
- Every candidate merge: relevant specialist reviewers, then `release-gate`.

Project-scoped reviewer definitions live in `.codex/agents/`. They are
read-only governance roles and must not be treated as application runtime code.

## Current foundation freeze

Until Warwick approves the next milestone, do not create:

- application features or Cockpit UI;
- integrations or connector credentials;
- databases, migrations, or live-data indexes;
- Power Platform or Dataverse assets;
- deployment or infrastructure configuration; or
- generated project scaffolding and dependency manifests.

Documentation changes that clarify the approved boundary are allowed. Any
expansion of scope requires Warwick's explicit approval.

