# Project ManagAIr MVP Build Contract

**Status:** Approved for implementation, including the person-neutral attention model
**Approved by:** Warwick

## North Star

In under one minute, Warwick can open a local Cockpit, understand the health of
two implementation projects, and identify the few items that require his
attention now.

The MVP proves one focused product idea: Project ManagAIr can turn structured
implementation-delivery data into a calm, trustworthy, cross-project control
surface. It is not a general personal knowledge system and does not attempt to
recreate myPKA.

## Why

Implementation projects spread attention across actions, risks, issues,
decisions, questions, milestones, work packages, delivery activity, and AI
outputs. A project-by-project review makes it easy to miss the one decision or
blocker that matters most across the portfolio.

The first build should test whether a lightweight local Cockpit can:

- give Warwick a portfolio view before he enters any one project;
- distinguish information from items that genuinely need intervention;
- make each attention signal traceable to its project and underlying record;
- show whether AI-produced work has been written and independently verified;
  and
- remain useful without connecting to any live system.

The read-only myPKA reference was inspected for interaction patterns only. The
useful patterns are a calm landing dashboard, persistent navigation,
list-to-detail routing, compact status signals, visible data freshness, and
honest loading, empty, and error states. Project ManagAIr will own its domain
model and implementation and will not copy the myPKA application wholesale.

## User

### Primary user

Warwick, acting as portfolio owner and implementation decision-maker.

### Jobs to be done

Warwick needs to:

1. see which projects are healthy, drifting, blocked, or stale;
2. find everything that specifically requires his attention;
3. understand why an item is in the attention queue;
4. move from a portfolio signal to the relevant project context;
5. inspect actions, delivery controls, and recent activity without editing them;
   and
6. see whether AI work is unwritten, drafted, awaiting verification, verified,
   or failed verification.

### MVP access model

The Cockpit is a single-user local application bound to loopback. The MVP has no
accounts, collaboration, tenancy, remote access, or authorization model because
it contains fictional data only. Reusable logic identifies the current user
generically. An optional local display name may personalize labels (for example,
`Needs Warwick`); without one, the product label is `Needs You`.

## Success Criteria

The MVP is successful when:

1. Warwick can start the Cockpit locally using one documented command after
   dependencies are installed.
2. The Home screen displays exactly two clearly fictional implementation
   projects.
3. Warwick can identify the highest-priority cross-project attention item
   without opening either project.
4. Every attention item explains why it needs the configured user and links to its project
   detail context.
5. Each project card communicates delivery status, next milestone, open
   attention count, and data freshness at a glance.
6. Each project detail page exposes actions, risks and issues, decisions, open
   questions, milestones, work packages, latest activity, and AI
   write/verification status.
7. Attention-queue membership is deterministic and covered by automated tests.
8. The interface is read-only: it contains no create, edit, delete, approve,
   complete, assign, sync, or write-back operation.
9. Runtime behaviour makes no request to a live project source or external
   product service.
10. All committed project records are explicitly fictional and pass fixture
    validation.
11. Loading, empty, error, and stale-data states are visible and truthful.
12. The core portfolio-to-project-detail journey is keyboard accessible and
    passes the agreed automated accessibility checks.

## Non-goals

The MVP will not include:

- personal knowledge management, journaling, notes, habits, goals, life areas,
  knowledge graphs, whiteboards, inbox capture, or agent rosters;
- Google Drive, OneDrive, Rocketlane, Dataverse, SharePoint, Power Platform, or
  any other live connector;
- live NPL, NWLDC, customer, employer, or personal data;
- authentication, multi-user access, permissions, remote access, or cloud
  hosting;
- editing, approvals, comments, notifications, write-back, or workflow
  automation;
- an embedded AI model, model API, prompt execution, or content generation;
- a database, search index, embeddings store, event bus, or background worker;
- configurable dashboards, custom fields, plugin systems, or user-defined
  schemas;
- document rendering or a source-file viewer;
- analytics beyond the minimum counts and statuses required for attention
  triage;
- mobile-native applications; or
- production deployment, telemetry, integrations, or secrets.

## Data Boundaries

### Allowed in Git

- reusable application code and schemas once build approval is given;
- automated tests;
- fictional fixtures created specifically for this product;
- fixture asset names and narrative content that are visibly synthetic; and
- product documentation.

### Forbidden in Git and the MVP runtime

- real customer or employer project records;
- NPL, NWLDC, or other live project content;
- real names, document titles, tenant identifiers, URLs, file paths, messages,
  or metadata derived from live work;
- credentials, tokens, cookies, connection strings, or secrets;
- copied or lightly disguised live data;
- myPKA application code or runtime data; and
- local caches, databases, logs, or generated source mirrors.

### Fixture policy

The build will contain two synthetic projects, provisionally named **Project
Atlas** and **Project Beacon**. Their organizations, people, dates, delivery
events, risks, issues, decisions, and AI statuses must be invented for the MVP.
Each fixture file must carry an explicit marker such as
`"dataClassification": "fictional"`.

Fixture dates should be anchored to a single declared `asOf` date so overdue,
due-soon, stale, and upcoming states remain deterministic in tests. The UI must
display that fixture timestamp and label the environment **Fictional demo
data**.

### Runtime boundary

The local server reads validated fixture files from the repository and exposes
read-only query endpoints. The browser may call only that local server. The
runtime must not contact external APIs, load remote fonts, or inspect sibling
`Data` or `Vendor` folders.

## Core Screens

The MVP has two primary routes and a deliberately small navigation model.

### 1. Home / Portfolio Dashboard

Purpose: answer "What needs my attention across both projects?"

Minimum content:

- a clear **Fictional demo data** banner and `asOf` timestamp;
- portfolio summary counts for projects, attention items, high risks/issues,
  pending decisions, and AI outputs awaiting verification;
- **Needs You** queue, ordered by urgency. An optional configured display name may render this as **Needs Warwick** in the fictional demo;
- two project cards;
- latest activity across both projects; and
- direct navigation from attention items and project cards to project detail.

The attention queue is the dominant element. Portfolio counts support the
queue; they must not become a decorative analytics dashboard.

### 2. Project Detail

Purpose: answer "What is happening in this project, and what is blocking
delivery?"

Minimum content:

- project identity, summary, delivery status, stage, owner, next milestone, and
  last-updated time;
- project-specific attention items;
- actions;
- risks and issues;
- decisions;
- open questions;
- milestones;
- work packages;
- latest project activity; and
- AI write and verification status.

Recommended MVP layout: a single scrollable page with anchored sections and
summary counts rather than a tabbed workspace. This keeps all project controls
findable, supports browser search, and avoids hiding attention signals.

### Shared interaction requirements

- persistent, minimal navigation for Portfolio and the two projects;
- deep-linkable project routes;
- browser back/forward support;
- filters may change the view but never mutate data;
- calm status chips with text and icon/shape, never colour alone;
- clear loading skeleton, empty state, error state, and stale-data state;
- every summary count links or scrolls to the records behind it; and
- read-only status and fixture freshness remain visible.

## Minimum Domain Model

The model is provider-neutral even though the MVP source is fixtures.

### Common record fields

Every project-owned record has:

- `id`: stable fictional identifier;
- `projectId`: owning project identifier;
- `title`: concise human-readable label;
- `status`: controlled status value appropriate to the record;
- `owner`: fictional display name or role;
- `updatedAt`: ISO timestamp;
- `dataClassification`: always `fictional` in the MVP; and
- `summary`: optional plain-language context.

### User Configuration

Local display configuration; it is not a reusable domain identity.

Minimum fields:

- `userId`: stable generic current-user identifier;
- `displayName`: optional presentation-only name; and
- `attentionLabel`: derived at render time as `Needs {displayName}` when a
  display name exists, otherwise `Needs You`.

The fictional demo may configure `displayName: "Warwick"`. Reusable schemas,
selectors, components, and tests must not require or branch on that name.

### Project

Minimum fields:

- `id`, `name`, `code`, `summary`;
- `deliveryStatus`: `on-track | watch | at-risk | blocked | complete`;
- `stage`;
- `owner`;
- `startDate`, `targetDate`;
- `nextMilestoneId`;
- `updatedAt`;
- `asOf`; and
- related record collections.

### Action

A concrete next step.

Minimum fields:

- common fields;
- `priority`: `low | medium | high | critical`;
- `dueDate`;
- `needsUserAttention`: boolean;
- `attentionOwner`: generic user identifier; and
- `attentionReason`: controlled reason when `needsUserAttention` is true.

### Risk or Issue

One model with a discriminating `kind`: `risk | issue`.

Minimum fields:

- common fields;
- `kind`;
- `severity`: `low | medium | high | critical`;
- `likelihood`: required for risks, omitted for issues;
- `impact`;
- `response`;
- `targetResolutionDate`;
- `needsUserAttention`; and
- `attentionOwner`.

### Decision

Minimum fields:

- common fields;
- `decisionStatus`: `proposed | awaiting-user | decided | superseded`;
- `decisionNeededBy`;
- `optionsSummary`;
- `outcome`;
- `needsUserAttention`; and
- `attentionOwner`.

### Open Question

Minimum fields:

- common fields;
- `question`;
- `answerNeededBy`;
- `blocking`: boolean;
- `needsUserAttention`;
- `attentionOwner`; and
- `resolution`.

### Milestone

Minimum fields:

- common fields;
- `targetDate`;
- `milestoneStatus`: `not-started | in-progress | at-risk | achieved | missed`;
- `completionPercent`;
- `workPackageIds`;
- `needsUserAttention`; and
- `attentionOwner`.

### Work Package

Minimum fields:

- common fields;
- `workPackageStatus`:
  `not-started | in-progress | blocked | in-review | complete`;
- `lead`;
- `startDate`, `targetDate`;
- `completionPercent`;
- `blockerSummary`;
- `milestoneId`;
- `needsUserAttention`; and
- `attentionOwner`.

### Activity Event

An append-only display record describing a meaningful fictional project change.

Minimum fields:

- `id`, `projectId`, `occurredAt`;
- `eventType`;
- `summary`;
- `actor`;
- `relatedEntityType`, `relatedEntityId`; and
- `dataClassification`.

### AI Work Status

Visibility into AI-assisted delivery work; the MVP does not execute AI.

Minimum fields:

- `id`, `projectId`;
- `label`;
- `relatedEntityType`, `relatedEntityId`;
- `writeStatus`:
  `not-started | drafting | draft-ready | complete | failed`;
- `verificationStatus`:
  `not-required | not-started | pending | verified | failed`;
- `verificationMethod`;
- `lastAttemptAt`;
- `verifiedAt`;
- `verifiedBy`;
- `statusDetail`; and
- `attentionOwner`.

### Attention Item

An attention item is a derived view, not a separately edited source record.

Minimum fields:

- `id`;
- `projectId`;
- `sourceEntityType`, `sourceEntityId`;
- `attentionOwner`;
- `reason`;
- `urgency`: `now | soon | watch`;
- `dueAt`;
- `title`; and
- `route`.

Initial deterministic inclusion rules:

- an action explicitly marked `needsUserAttention` for the current `attentionOwner`;
- a high/critical open risk or issue marked `needsUserAttention` for the current `attentionOwner`;
- a decision in `awaiting-user` for the current `attentionOwner`;
- an unanswered question marked `needsUserAttention` for the current `attentionOwner`;
- a blocked work package or missed milestone assigned to the current `attentionOwner`;
- an AI output whose verification failed; or
- an AI output that is `complete` while verification is still pending beyond
  the fixture's agreed threshold.

Initial ordering:

1. `now` before `soon` before `watch`;
2. overdue before future-dated;
3. earliest due date first; and
4. stable ID as the deterministic tie-breaker.

## Proposed Technology Stack

The stack should be familiar, local, typed, and intentionally less elaborate
than the future live-data architecture.

### Recommended stack

- **Runtime:** current supported Node.js LTS, local loopback only.
- **Language:** TypeScript across server, domain model, fixtures, and UI.
- **Web UI:** React.
- **Build tooling:** Vite.
- **Local server/API:** Express, serving the built SPA and a small read-only JSON
  API from one origin.
- **Validation:** Zod schemas at fixture load and API boundaries.
- **Data source:** committed JSON fixture files; no database.
- **Routing:** a small client-side router with deep-linkable Portfolio and
  Project Detail routes.
- **Styling:** semantic HTML, CSS custom properties, and locally bundled/system
  fonts; no remote asset dependency.
- **Unit/component tests:** Vitest and React Testing Library.
- **End-to-end tests:** Playwright.
- **Accessibility checks:** semantic/manual checks plus automated axe checks in
  the core end-to-end journey.
- **Package management:** npm with a committed lockfile.

### Proposed shape

```text
Fictional JSON fixtures
        |
        v
Zod validation + domain selectors
        |
        +----> deterministic attention rules
        |
        v
Read-only local Express API
        |
        v
React Portfolio and Project Detail views
```

### Why this stack

- one language and one package tool keep the first build approachable;
- typed domain contracts reduce drift between fixtures, selectors, API, and UI;
- a thin local API preserves the future connector boundary without introducing
  a database;
- a single origin keeps the local runtime and security model simple; and
- fixture validation makes the fictional-data boundary executable rather than
  merely documented.

This stack is approved for the MVP. Versions are pinned during implementation.

## Acceptance Criteria

### Scope and data

- [x] The application contains exactly two implementation projects.
- [x] Both projects and every related record are marked fictional.
- [x] No live source connector, credential, customer record, or employer record
      exists in the repository or runtime.
- [x] The runtime does not read outside the repository or make an external
      network request.
- [x] No database is required or created.

### Portfolio

- [x] Home shows a visible fictional-data label and fixture `asOf` time.
- [x] Home shows both project cards with status, stage, next milestone,
      attention count, and freshness.
- [x] Home shows a single cross-project **Needs You** attention queue, optionally personalized from display configuration.
- [x] Attention items are ordered by the documented deterministic rules.
- [x] Every attention item explains its inclusion and links to project detail.
- [x] Home shows the latest meaningful activity across both projects.

### Project detail

- [x] Each project has a deep-linkable detail route.
- [x] Each detail page shows all nine required areas: actions; risks and issues;
      decisions; open questions; milestones; work packages; latest activity; AI
      write/verification status; and project-specific attention.
- [x] Empty sections state that no records exist rather than disappearing or
      rendering placeholders.
- [x] Summary counts reconcile with the displayed records.

### Read-only behaviour

- [x] No UI control mutates fixture or runtime data.
- [x] No POST, PUT, PATCH, or DELETE application endpoint exists.
- [x] Filters, links, anchors, and navigation are the only interactive controls
      beyond disclosure/collapse behaviour.
- [x] A persistent read-only indicator is visible.

### Quality

- [x] Fixture and API payloads pass schema validation.
- [x] Unit tests cover every attention inclusion rule and ordering rule.
- [x] Component tests cover portfolio and project detail states.
- [x] An end-to-end test covers Home -> attention item -> project detail ->
      relevant section.
- [x] Loading, empty, error, and stale states are tested.
- [x] The core journey is usable by keyboard and passes agreed automated
      accessibility checks.
- [x] The production build succeeds from a clean checkout using documented
      commands.
- [x] A repository scan finds no prohibited live-data indicators or secrets.

## Approved Decisions

| Decision | Approved MVP default |
|---|---|
| Product focus | Portfolio attention and project delivery only; no PKM features |
| Project count | Exactly two fictional projects: Atlas and Beacon |
| Primary route structure | Portfolio Home plus one detail route per project |
| Project-detail layout | Single page with anchored sections, not tabs |
| Attention ownership | Person-neutral `needsUserAttention` and `attentionOwner`; generic label `Needs You`; optional configured display name |
| Attention urgency | `now`, `soon`, `watch` with deterministic date ordering |
| Risk display | Calm status language; reserve red for blocked/critical/failed states |
| AI scope | Display write and verification statuses only; execute no AI |
| Verification meaning | `verified` requires an identified fictional verifier and method |
| Data architecture | Validated JSON fixtures through a read-only local API; no database |
| Technology stack | TypeScript, React, Vite, Express, Zod, Vitest, Playwright |
| Local access | Loopback-only, single user, no authentication for fictional MVP |
| Routing | Deep-linkable client routes with browser back/forward support |
| Fixture date model | Fixed `asOf` timestamp for deterministic demos and tests |
| Visual direction | Dense enough for delivery control, calm enough for rapid scanning |
| Launch experience | Documented terminal command for MVP; no installer or auto-launch |

There are no remaining product decisions blocking the fictional-data MVP.

## Build Sequence

This sequence is approved for implementation.

### 1. Lock decisions and invariants

- retain the approved stack, fixture names, attention rules, and detail layout;
- keep all reusable attention logic person-neutral;
- keep live integrations and writable behaviour explicitly out of scope.

### 2. Establish the application skeleton

- create the minimum TypeScript workspace;
- configure local server, web build, tests, linting, and formatting;
- add no database, connector, authentication, or deployment configuration.

### 3. Define domain schemas and fixtures

- implement the minimum domain model;
- create two visibly fictional project datasets;
- validate every fixture at startup/test time;
- add fixture-boundary tests and the fixed `asOf` clock.

### 4. Implement selectors and read-only API

- implement project summaries and project detail queries;
- implement attention inclusion and ordering rules as pure functions;
- expose GET endpoints only;
- test schema validation, counts, attention derivation, and error behaviour.

### 5. Build the Cockpit shell and Home

- add minimal persistent navigation and read-only/fictional indicators;
- build portfolio summary, attention queue, project cards, and latest activity;
- implement loading, empty, error, and stale states.

### 6. Build Project Detail

- build summary and project-specific attention;
- add the required delivery-control sections;
- connect attention links and summary counts to their underlying records.

### 7. Add AI status visibility

- display write and verification state;
- highlight failed or overdue verification through the same attention rules;
- do not add model calls, prompts, editing, or approvals.

### 8. Verify the complete story

- run unit, component, end-to-end, accessibility, build, and boundary checks;
- verify no external runtime requests or non-GET application routes exist;
- complete a manual configured-user acceptance pass.

### 9. Package the local MVP

- document install, start, test, and build commands;
- document fixture editing rules for developers;
- stop at a local fictional-data MVP and seek approval before any live-source
  phase.

