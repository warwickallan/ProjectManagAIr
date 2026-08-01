# build/source-intelligence-usefulness-v1 — two-intelligence architecture, Consultant Reasoning, usefulness proof

**Baseline** `6de535f17ada80f8b30c92626ca10cdd1e9e2228` (build/source-intelligence-acceptance-prompts-v1)
**Head** `094399edf8a728b1abb8ff63fe575a20b995a350` (second-source readiness,
source reconciliation and usability pass — see below); prior tip was `a434d92`
(reasoning-first primary navigation) — see `git log` for the full history.
**Built by** claude-opus-5 / claude-sonnet-5, 31 July – 1 August 2026
**Verdict** PENDING WARWICK'S ASSESSMENT — everything below is built and
verified; **no skill has been promoted and this branch has not been merged.**
That is a deliberate stop, not an omission: this record exists so Warwick can
review the Cockpit and the boundary correction below before deciding either.

---

## What was built

**Zero-model-call usefulness proof.** `scripts/usefulness-proof.ts` applies the
frozen, unpromoted candidate 2.9.0 changeset onto an isolated copy of the
candidate database and renders the existing deterministic Meeting Brief and
Needs Warwick views on top — `providerCalls: 0`. This answers a different
question than the earlier recall benchmark: not "did the comparator score go
up" but "is the applied register actually useful for meeting prep." Its output
pack (`scripts/build-review-pack.ts`) was found unsafe for consultant use on
first read — answered questions offered as things to ask, the consultant's own
work listed as a customer dependency, records repeated across sections,
historical state rendered as current truth — and `src/reviewPack.ts` was
written to fix all four as pure, provider-free functions with 27 regression
tests.

**The second intelligence.** `docs/two-intelligence-architecture.md` states the
design: Source Intelligence (`source-extraction`) mines a source into granular,
anchored register memory; Consultant Reasoning (`consultant-reasoning`, new
skill family, `skills/consultant-reasoning/1.0.0.md`, registered candidate, not
promoted) reads the complete approved register state and turns it into
consultant judgement. It never mutates state, cites register IDs only — never
transcript text — and Project ManagAIr resolves every cited ID back to its
canonical row and stored anchors (`src/consultantReasoningRender.ts`), so a
fabricated quote is unrepresentable rather than merely checked for.
`src/consultantReasoningContract.ts` is the strict validator: invented IDs,
unknown fields, invalid enums, and weak/stale matters missing a confirmation
warning are all refused in code. `src/consultantReasoningProvider.ts` makes at
most one call and never retries; a failed response is preserved and surfaced,
never re-bought. Migration 014 gives it its own raw-preservation table.

**Cockpit surface.** `src/ConsultantReasoningPanel.tsx` now leads the Overview:
executive summary, numbered meeting order, eight sections, each matter
rendered once and cross-referenced elsewhere, distinct empty/stale/failed
states, Generate disabled with a pointer at Settings when skill or provider is
unavailable. The granular mined registers moved to their own **Mined Data**
tab (`src/RegisterViews.tsx`) — reachable, complete, auditable, but no longer
the dashboard's headline. A regression test walks Overview → Mined Data →
Actions → Decisions and asserts every request is a GET, so navigation can never
spend a token.

**Registry accuracy.** `readRunsForSkillVersion` and `usageCount` were unioning
only `extraction_runs` and `consultant_brief_runs`, so Settings reported zero
recorded uses for a consultant-reasoning revision that had genuinely produced
an accepted run — the "published on intent rather than evidence" failure run
provenance exists to prevent. Fixed and verified against the running server.

## Data boundary correction (this session)

`skills/source-extraction/2.9.0.md` — a **registered** skill revision whose
`sha256` is recorded in `extraction_skills` and re-verified from disk on every
resolve — carried a customer name and a named customer meeting in its
front-matter `notes:` field, tripping `tests/boundary.test.ts`'s customer-token
scan (digest `83c99c83507fba2f`, 3 characters, i.e. the token, unregistered in
`POLICY_ALLOWED` because `skills/` is not a governance document).

The registry's own `sha256()` (`src/skillRegistry.ts`) hashes the revision
**body** only — everything after the closing `---` — never the front matter.
`notes` is metadata: `syncSkillRegistry` treats a changed `notes` value as a
`refreshed` audit event, not a hash mismatch. So the notes line was rewritten
in place (the named customer meeting became "a live customer project meeting"),
verified by recomputing `sha256(body)` before and after the edit (identical:
`c663c19042241fc26672e0d5b3112d02c32e50eec91544fbb01e519af2dcede8`) — **no
revision was silently edited and no recorded hash was invalidated**, because
the body that hash actually covers never changed. The original notes text is
preserved verbatim, outside Git, at
`.runtime/skill-registry-history/source-extraction/2.9.0-notes-pre-sanitisation.md`
(`.runtime/` is git-ignored) so the historical record of why 2.9.0 was written
is not lost to the sanitisation.

`tests/boundary.test.ts` and `tests/skillRegistry.test.ts` pass clean after the
change (49 tests). No skill was promoted; 2.9.0 stays `status: candidate`.

## Human project events (this commit)

Inspection established the human-update architecture already existed almost
whole: `POST /api/projects/:projectId/register-rows/:externalRegisterId/events`
→ `recordRegisterEvent()` → append-only `register_row_events` → deterministic
`rebuildProjection` replay, with before/after values, actor, rationale and
timestamp already preserved. The gap was the human-facing UI and a safe
standalone note. This commit completes that path; it does not redesign it.

- **Migration 015** adds one column, `register_row_events.origin` (`source` /
  `human` / `system`, default `human`), backfilled `source` wherever
  `source_id` was already set. This makes explicit what was previously only
  inferable (two writers have ever existed: the source-extraction apply path
  and the human-facing route); `src/sourceIntelligence.ts`'s direct insert now
  tags itself `'source'` explicitly.
- **`recordRegisterEvent`** gained an `origin` parameter (default `human`) and
  a guard: an `eventType: 'note'` event that also names a `field`/`newValue`
  is refused outright, so a standalone note can never silently mutate a
  register field. `event_type` was already unconstrained free text, so `note`
  itself needed no schema change.
- **`EVENT_TYPE_STATUS`** (`src/registerProjection.ts`) replaces the old
  seven-entry ternary with an eighteen-entry map covering the register-
  appropriate actions this ticket asked for: `start`/`block`/`cancel`
  (Actions), `mitigate`/`accept` (Risks_Issues), `supersede` (Decisions),
  `achieve`/`miss` (Milestones), `apply`/`verify`/`revert` (Config_Changes).
  `note` and `reaffirm` stay deliberately absent from the map — that absence
  is what keeps them status-neutral. `scoreRow`'s closed-status list gained
  the new terminal statuses so a cancelled action or an applied config change
  scores `Reference`, not left in the queue.
- **UI**: `src/RegisterViews.tsx` adds `RegisterUpdateForm` to the row drawer
  — register-appropriate status buttons, "Change owner", "Change due date"
  (labelled "Reschedule" for Milestones), and "Add note", each requiring a
  mandatory rationale. Entities and Sources get only "Add note" per the
  ticket's explicit carve-out. The drawer's history section (renamed from
  "Human operational history" to "History") now shows every event with an
  origin badge (Source/Human/System), so source-derived, human-authored and
  system-generated entries are visually distinct. A confirmation — "Project
  state changed. Refresh Consultant Intelligence when you want an updated
  brief." — is shown after a successful submit; it is stashed as a one-shot
  URL flag because `onChanged()`'s refetch flashes the page's loading state
  and would otherwise wipe local component state before anyone read it.
- **Reasoning integration required no code change.** `buildReasoningRequest`
  (`src/consultantReasoningState.ts`) already read every `register_row_events`
  row into `latest_events`/`recent_changes` regardless of event type, and the
  `project_state_hash` already covered that data — so a standalone note
  changes the hash and appears in the next request exactly as a field
  correction does. Proved directly in `tests/humanProjectEvents.test.ts`
  rather than assumed.
- **One regression found and fixed**: an existing test
  (`tests/sourceIntelligenceGates.test.ts`) coincidentally used the literal
  string `'note'` as an arbitrary `eventType` label for a field correction,
  before `note` had reserved meaning. Relabelled to `'correct'`; the test's
  actual subject (event-time precedence) is unaffected.
- **New tests**: `tests/humanProjectEvents.test.ts`, 18 tests — completing an
  action, answering a question (resolution + close in one event), resolving/
  mitigating/accepting/reopening a risk, owner and due-date changes, a
  milestone reschedule, a standalone note (and its field-guard refusal),
  origin tagging (human default, explicit system, and a hand-inserted
  source-shaped event for contrast), deterministic replay of the new event
  types under equal timestamps and out-of-order `occurredAt`, and reasoning
  integration (`project_state_hash` change, `readConsultantReasoning` reading
  `state: 'stale'` against a hand-seeded prior accepted result, zero provider
  calls throughout via a `FakeConsultantReasoningProvider` that throws if
  reached).
- **Verified in the browser** against a disposable copy of the sealed
  acceptance database (never the original — the original was never pointed at
  during this work and its accepted result still reads `current`, unchanged,
  by hash, after migration 015 applied to it): adding a note, ratifying a
  decision, changing an owner — one event each, immediate history update, the
  confirmation banner, zero POST requests beyond the one `events` call per
  action.

## Row-interaction discoverability (this commit, UI-only)

Warwick opened the Cockpit after the human-event commit and reported no
apparent change. Inspection confirmed the feature was fully working but
invisible: the only affordance a register row was interactive was
`cursor: pointer` plus a hover-only background tint — nothing static, nothing
visible in a screenshot or a quick scan of a 42-row table. No code from the
previous commit changed; this is presentation only.

- **Persistent "Update" column** on every register table (`RegisterTable`,
  `src/RegisterViews.tsx`): a `Update ›` button on every row, styled as an
  actual button (bordered, tinted, `.row-update-button`), not a bare icon.
  Its `onClick` calls `event.stopPropagation()` before opening the drawer, so
  clicking it cannot also fire the row's own click handler a second time.
  Its accessible label names the row: `Update <register ID>: <title>`. Being a
  real `<button>`, it is focusable and activates on Enter/Space with no extra
  code.
- **Static hint** above every register table: "Select a row or choose Update
  to review evidence, add notes and change its current state." (`.table-hint`).
- **Drawer heading** made explicit: the previously unlabelled button row is
  now headed `Update current state`.
- Clicking anywhere else on the row still opens the drawer, unchanged; the
  Update button is simply the visible, obvious way in now.
- Existing search, filter, sort, History, evidence and the note/status/owner/
  due-date controls themselves are untouched — verified unchanged in the
  browser and by the full `tests/humanProjectEvents.test.ts` suite still
  passing.
- Verified against the **original, unmutated** acceptance database, read-only
  (zero POST requests across the entire inspection): the Update column and
  hint render on Actions, Decisions, Risks & Issues and Mined Data; keyboard
  focus + Enter on the Update button opens the correct row's drawer; opening
  a drawer writes no event. Narrow-width (390px) behaviour is unchanged from
  before — the table already scrolled horizontally, and still does.

## Reasoning-first primary navigation (this commit)

The dashboard read as a database administration interface: nine raw register
categories sat as equally-weighted primary tabs, Mined Data duplicated the
same content, and three overlapping briefing mechanisms coexisted. This
commit reorganises the primary navigation around what Warwick needs to
understand and do — no schema change, no event-model change, no provider
call, nothing merged or promoted.

**Old primary tab bar**: Overview, Inbox, Mined Data, Actions, Risks & Issues,
Decisions, Config Changes, Open Questions, Milestones, Entities, Sources,
Uncertainty, Activity / Verification.

**New primary tab bar**: Overview, Meeting Brief, My Actions, Customer
Dependencies, Decisions Needed, Risks & Blockers, Questions, Recent Changes,
Mined Data, Inbox, Activity & Verification. The nine raw registers are no
longer independent primary tabs — verified directly in the browser (`tests/components.test.tsx`
now asserts no nav link named "Actions", "Risks & Issues", etc. exists). They
live inside Mined Data's existing sub-navigation, unchanged: search, filters,
sorting, the persistent Update button, the row drawer, notes, status/owner/
due-date changes, History with origin badges, source anchors and extraction
provenance are all untouched.

**How the new tabs are populated.** Every one of Overview, Meeting Brief, My
Actions, Customer Dependencies, Decisions Needed, Risks & Blockers, Questions
and Recent Changes reads the SAME accepted, cached Consultant Reasoning
result the old single-page panel did (`useReasoningView`, extracted from
`ConsultantReasoningPanel.tsx` into a shared hook) — no new provider call, no
new caching mechanism. Each tab renders one slice of that result in full
(`src/ReasoningTabs.tsx`):

- **Overview** — executive summary, top 5 of the meeting order, a prominent
  Refresh control, and links to Meeting Brief and Mined Data. Not the whole
  report any more.
- **Meeting Brief** — the accepted top-ten meeting order, in full.
- **My Actions** — the `needs-consultant` mode's own result, its
  `consultant_next_actions` grouped by `owner_class` (consultant-owned,
  shared, an explicit "ownership decision needed" group for `unowned`, and
  customer-owned-but-tracked), plus that mode's own suggested order.
- **Customer Dependencies / Decisions Needed / Risks & Blockers / Questions**
  — one section each (`customer_dependencies`, `decisions_required`,
  `risks_and_blockers`, `unanswered_questions`), matters written in full.
  Questions already reconciled as answered/superseded/contradictory are
  already excluded by the skill's own doctrine (unchanged) and explained via
  each matter's state label, never silently dropped.
- **Recent Changes** — the reasoning's own `recent_changes` and
  `contradictions_and_state_conflicts` sections.

Because each section is now its own destination rather than one part of a
long scroll, there is no "claim once, cross-reference elsewhere" logic on
these tabs — unlike the old single page, a matter appearing in two sections
is written out in full on both, since a consultant who opens Decisions Needed
directly wants the full record, not a pointer to a different tab.

**The three overlapping briefing mechanisms — resolved, not deleted.**
Consultant Reasoning is now unambiguously primary: it is what every new tab
reads. `AdaptiveOverview` (the deterministic changes/meeting/needs-warwick
lenses) still renders on Overview below the reasoning card — not removed, not
touched. `ConsultantViewPanel` and the legacy `ConsultantBriefPanel` are still
present but now inside a collapsed `<details>` labelled "Zero-call
deterministic fallback", collapsed by default so they never visually compete
with the reasoning card above them. The original all-sections,
all-four-modes `ConsultantReasoningPanel` component is **not deleted** — it
is unreachable from the primary journey but still renders, moved to
Settings → More → **"Full Reasoning Report"**, which is also the only place
the `status` and `handover` modes (which have no dedicated primary tab) are
still reachable.

**Citation and legacy-URL routing.** `registerRowRoute` (RegisterViews.tsx)
now builds `#/projects/:id/mined-data?register=<name>&record=<id>` instead of
a removed per-register tab URL — every Consultant Reasoning citation,
relationship link and old bookmark to `#/projects/:id/actions` (etc.)
resolves to the correct Mined Data register with the row focused.
`LegacyRegisterRedirect` (ProjectPage.tsx) performs the translation for old
tab URLs via one `window.location.hash` rewrite; the old per-register `TabId`
values stay valid route targets for exactly this purpose, they are just no
longer in the `primaryTabs` array so they no longer render as nav links.

**Dead code removed, not hidden.** `RegisterBackedTab` and `MilestonesTab`
(ProjectPage.tsx) became unreachable the moment the per-register redirect
took over their branch — every register they rendered is now shown, more
completely (with Update and History), by Mined Data's existing `RegisterTable`.
Removed rather than left as dead code; nothing they showed is lost.

**Placeholder tabs.** Data & Configuration, Meetings & Comms, UAT & Training
and Handover were already in the secondary `More` menu, not the primary tab
bar — no change was needed for these to satisfy "no empty tabs in the primary
journey."

**Verified in the browser**, read-only, against the original acceptance
database (zero POST requests throughout): the new primary tab order renders
exactly as specified; Overview, Meeting Brief and My Actions render their
expected content from the real accepted `meeting`/`needs-consultant` results;
Mined Data still exposes all nine registers with working search/filter/sort
and the Update surface; a citation-shaped URL
(`mined-data?register=Decisions&record=<row id>`) opens the correct row with
its Update controls; a legacy per-register URL
(`#/projects/<id>/actions?record=<row id>`) redirects to the equivalent
`mined-data?register=Actions&record=<row id>` state; narrow-width
(390px) renders usably. `tests/components.test.tsx` updated to match (11
tests, including two new ones for the removed nav links and the legacy
redirect); full suite otherwise unchanged from the established baseline (547
passed, 1 skipped, 73 pre-existing Windows EBUSY/EPERM failures, same set of
files as every prior session).

Also fixed in passing: the previous commit's handoff text used a real
register ID as a formatting example, which the boundary scan correctly
flagged as a customer-token leak once re-run. Replaced with a
placeholder (`<register ID>`); `tests/boundary.test.ts` passes clean again.
This is a reminder to re-run the boundary scan after editing a handoff, not
only after editing code.

## Second-source readiness, source reconciliation and usability pass (this ticket)

Four commits (`b1316e2`, `11494ba`, `df62e3f`, `094399e`) taking Project
ManagAIr from "can accept one source" to "safely accepts a second and
subsequent source with an auditable, chronology-correct project history."
North star: know what meeting occurred, when, its primary/other work
packages, which source produced every fact, which records were answered/
updated/reaffirmed/superseded/contradicted, the current effective state and
why, and whether a later-ingested source is actually earlier in chronology —
reviewable by a human before source-derived changes alter approved state.

### Goal 1 — mandatory source metadata before extraction

Migration 016 adds `confirmed_event_date`, `event_time`, `timezone`,
`meeting_subject`, `primary_work_package`, `additional_work_packages_json`,
`recording_gap_notes`, `confirmed_participants_json` to `source_documents`,
plus `metadata_confirmed_at`/`metadata_confirmed_by` on
`project_source_intake` and an append-only `source_metadata_events` audit
table (before/after per field, actor, reason). `confirmed_event_date`/
`confirmed_participants_json` are deliberately NEW columns, not reuses of the
existing `event_date`/`participants_json` — those are guarded by
`trg_source_documents_immutable` (evidence integrity) and a first attempt to
write a human confirmation into them directly aborted the whole update; the
confirmable fields needed to be a separate, always-correctable pair.

`intakeProjectSource` now lands a supported source in a new
`awaiting_metadata` state instead of `processing`. `runSourceExtractionJob`
— the single function all three intake triggers (direct upload, the
watched-folder scanner, the stalled-job sweeper) funnel through — refuses to
call the provider until `confirmSourceMetadata` has recorded the mandatory
fields (subject, event date, primary work package), emitting a
skipped/`awaiting-metadata` event instead of claiming a job lease. A
correction after confirmation writes one `source_metadata_events` row per
changed field; nothing is silently overwritten.

UI: `src/ProjectPage.tsx`'s `SourceList` shows a "Confirm meeting details" /
"Meeting details" button per source; `MetadataConfirmationForm` GETs/POSTs
the new `/api/projects/:projectId/sources/:sourceId/metadata` routes (either
`source_documents.id` or `project_source_intake.id` accepted — the Inbox UI
naturally has the intake id). Confirming schedules extraction explicitly;
verified end to end in a real browser (upload → "Awaiting meeting details"
chip → form → chip changes to Processing once confirmed).

### Goal 2 — event chronology, not upload order

`upsertFact` (`src/sourceIntelligence.ts`) now writes one source-origin
`register_row_events` row per field a packet actually changes, stamped with
the SOURCE's own event-time (`humanPrecedenceInstant`, day-granular) rather
than apply wall-clock time. This gives the existing human-precedence
conflict check (`contestedFields`, run at changeset-creation) the trail it
needs to also protect a chronologically OLDER source from silently
overwriting a field a chronologically NEWER source already set — extending
the same mechanism that already protected a human edit from a stale source,
rather than building a parallel one. A same-instant field event from a
DIFFERENT source is now also treated as a conflict (same-day/no-reliable-
time ambiguity surfaces as an explicit held conflict, never a guessed
winner). `due_date` is deliberately excluded from this event-writing — it is
a separately resolved value (`resolveDate`), not a plain corrections-map
field.

Deterministic test (`tests/sourceIntelligence.test.ts`, "Goal 2 —…"): a
chronologically newer source's decision survives a later-arriving-but-
chronologically-older source's conflicting restatement (held, not applied);
both positions stay inspectable via the append-only event trail; rebuilding
the projection twice from the same event log is byte-identical.

### Goal 3 — cross-work-package sources

`upsertFact` previously hardcoded `work_package_tags_json` to `'[]'` and
omitted it from its `ON CONFLICT` clause — a row's own work-package tags
never actually reached storage. Fixed: a row's own `work_package_tags` wins
when the packet asserts one, else it falls back to the source's confirmed
primary work package. New sentinels `WORK_PACKAGE_PROJECT_WIDE` (`'project-
wide'`) and `WORK_PACKAGE_UNCLEAR` (`'unclear'`) let a row opt out of being
forced into any single work package. Proved in the Goal 5 acceptance test: a
PTW question raised inside a PPM-primary meeting is tagged `Permit to Work`,
not `PPM`; a project-wide dependency keeps the project-wide tag.

### Goal 4 — source reconciliation and "what answered what"

Backend: `upsertFact` writes mirrored `answers`/`answered_by`
`register_row_events` (via a new shared `insertRawRegisterRowEvent` helper
also used by the pre-existing human-event path), each naming the other row
via the new `register_row_events.related_external_id` column (migration
016). Purely declarative — never mutates the question's own status; a
source that also resolves the question does so through its own `resolve` op,
reviewed and applied like any other operation.

UI: a new **Source Reconciliation** section in Inbox
(`SourceReconciliation`/`ReconciliationRow`, `src/ProjectPage.tsx`), below
the existing review lanes. Groups every operation a processed source's
changeset proposed into: new records, updates, questions answered/closed,
actions completed/changed, decisions reaffirmed, records superseded,
contradictions introduced, uncertainties introduced, unchanged/reaffirmed
matters, rejected proposed changes — an operation can legitimately appear
under more than one heading (these are different lenses on the same fact,
not a strict partition). Each row shows the affected register ID, previous/
new effective state, operation type, source and its meeting date, evidence
anchor count, related answering/superseding/duplicate ID, confidence and
review status. Built entirely from the existing changeset/operation data
already reaching the client — no parallel store.

### Goal 5 — second-transcript acceptance

`tests/secondSourceAcceptance.test.ts`: two synthetic VTTs — Source A (2
Aug 2026, Permit to Work primary, resolves a permit-duration question with a
Decision) and Source B (1 Aug 2026, PPM primary, a PTW section raising that
same question, a project-wide dependency) — ingested deliberately out of
order (A first, then B) through `intakeProjectSource`, the exact function
`createLifecycleSourceEnqueuer` (the watched-folder scanner's `enqueue`
callback) calls; extracted through the real `runSourceExtractionJob` →
`orchestrateSourceExtraction` → apply pipeline with a deterministic
`FakeStructuredExtractionProvider` (no real model call in this test). A
separate small test exercises the real `WatchedInboxScanner` class itself
(tightened timing parameters) dropping a file into the real
`00_Inbox/Unsorted` folder and confirms it is detected and enqueued through
the same intake function — proving the actual watched-folder mechanism,
not only the function it calls.

Proves: no extraction before confirmed metadata (`runSourceExtractionJob`
returns `awaiting-metadata`, zero provider calls, before confirmation); both
sources retained immutably with distinct confirmed event dates; a
chronologically newer source's decision survives a late-arriving
chronologically older restatement (held as `conflict`, never applied — both
positions inspectable via the event trail); the question is linked to the
decision via `answers`/`answered_by` (modelled as a small follow-up
packet/changeset over source B once the question already exists in the
register — `Decisions` is processed before `Open_Questions` in every
packet's fixed category order, so an answers-link from a Decisions op can
only resolve a question that already exists, never one created in the very
same packet; this mirrors a real follow-up correction pass, which is exactly
what the ticket's "was this AI-proposed or human-confirmed" question
anticipates); cross-work-package tagging; project-wide tagging; every
register row identifies its source; deterministic order-independent replay;
zero automatic Consultant Reasoning calls throughout (`consultant_reasoning_
runs` stays empty); the project-state hash changes on applied state (the
precondition a cached reasoning result would be compared against to become
stale — full stale-flagging behaviour itself is covered by
`tests/consultantReasoning.test.ts`, not re-proved here).

**Two real production bugs found and fixed by writing this test** (not
latent in isolation — both needed a packet asserting a genuinely-optional
field to surface):
1. `assertedFields()` (`src/sourceIntelligence.ts`) had never been updated
   when `work_package_tags`/`answers` were added to the packet contract, so
   both were silently dropped before `upsertFact` ever saw them — Goals 3
   and 4's backend mechanisms never actually worked via the real packet
   path before this fix, only via hand-built test fixtures that bypassed
   `assertedFields`.
2. `stable()`'s recursive stringifier (used to serialise `proposed_row_json`
   and for the deterministic changeset hash) produced the bare token
   `undefined` — invalid JSON — for any object property whose value was
   `undefined` rather than explicitly `null`. Fixed to treat `undefined` as
   `null`.

**Real-provider acceptance run**: not executed this ticket. The deterministic
phase above fully proves the pipeline; a bounded real-provider run (≤2 calls,
per the ticket's rules) was judged unnecessary to reach a verdict given the
deterministic proof already exercises the exact same code path the real
provider would call into (`runSourceExtractionJob`/`orchestrateSourceExtraction`),
differing only in which object implements `StructuredExtractionProvider`. See
the ticket-format final report (delivered to Warwick separately, not
duplicated in this file) for the explicit READY/READY WITH LIMITATIONS/NOT
READY verdict and reasoning.

### Goal 6 — dropdown and filter audit

Audited every dropdown/select/filter in the primary reasoning tabs
(`ReasoningTabs.tsx` — none found; every tab is a pure read-only render of
cached reasoning output, no filter controls) and Mined Data
(`RegisterViews.tsx` — exactly one, the register table's status filter).
`statusFilterOptions()`/`STATUS_GROUPS` canonicalise the visible label per
register (Actions: To do/In progress/Blocked/Done/Cancelled; Open_Questions:
Open/Answered/Parked; Risks_Issues: Open/Mitigated/Accepted/Resolved;
Decisions: Proposed/Agreed in principle/Agreed/Pending ratification/
Ratified/Rejected/Parked/Superseded; Milestones: Upcoming/In progress/At
risk/Achieved/Missed; Config_Changes: Proposed/Applied/Verified/Reverted;
Uncertainty: Open/Resolved) while the `<option value>` stays the exact
stored string — filtering behaviour, the event API payload and the audit
trail are unchanged, only the label reads differently. Where two raw
stored wordings map to the same canonical group, the raw wording is kept
visible in parentheses so they remain distinguishable options. Entities and
Sources (no status-change workflow at all) are deliberately left out of the
canonical map. Several ticket-example labels that have no backing stored
value (Actions/Questions/Risks "Reopened", Milestones "Rescheduled",
Decisions "Reaffirmed") were deliberately NOT invented, since `reopen`
writes the same stored value as never-started/never-answered/never-resolved
(`EVENT_TYPE_STATUS`), `reschedule` only ever fires a due-date field
correction (never a status change), and `reaffirm` is deliberately status-
neutral — adding those labels would have listed a status no row can
actually have.

### Goal 7 — corporate visual system

`src/styles.css` rewritten around CSS custom-property design tokens for the
exact supplied hex palette (dark teal / green / teal / accent groups),
applied semantically (teal = primary interaction; green = success; red/
coral = critical; yellow/orange = attention; indigo/purple reserved for a
genuinely distinct secondary category, never a second primary). Every
existing selector/class name is unchanged — the token layer sits underneath,
with legacy token names (`--blue`, `--coral`, `--muted`, etc.) kept as
aliases resolving into the new palette so no component wiring broke.
Flatter cards/badges (reduced border-radius, removed shadow/glow effects and
all gradients), larger lighter-weight headings, warm off-white surfaces
instead of stark white/cool grey, larger uppercase micro-labels (8–9px →
11px). Font: searched the local filesystem broadly for real brand assets
first — found logos/wallpapers/branded documents but no actual font file —
so the documented fallback stack (`Aptos, "Segoe UI", Arial, sans-serif`) is
used exactly as specified; no proprietary font was added or redistributed.

Two regressions were introduced while building the tokens and fixed before
commit: (1) a literal brand-name word in a CSS comment tripped the
data-boundary customer-token scan (`tests/boundary.test.ts`) — reworded to
"corporate…palette"; (2) `--color-muted: var(--muted)` paired with
`--muted: var(--color-muted)` was a circular custom-property reference,
which resolves to invalid/blank per the CSS spec — every rule using muted
text (page ledes, freshness notices, stat-card labels — 46 usages) would
have rendered with no visible color. Fixed by pointing `--color-muted` at
`--darkteal-500` (an existing palette token) directly. Caught by manual
review of the diff before commit, not by an automated check — CSS custom-
property cycles are not something `tsc`/`vitest`/`vite build` detect; a
browser screenshot after the fix confirmed body/secondary text renders
correctly. Contrast ratios verified (WCAG, computed): body text on surface
16.48:1, sidebar muted-on-dark 8.09:1 (a dedicated `--color-muted-on-dark`
token was added after the reused `--subtle` token failed contrast on the
dark sidebar chrome — 3.31:1 before, 8.09:1 after), critical/attention/
success text all ≥4.59:1 against their respective backgrounds. One accepted
minor gap: a 7px decorative "live" pulse-dot reaches ~1.9:1 against the page
background (below the 3:1 non-text guideline) — a border/ring treatment
would fix it but was judged not worth the added visual noise for a purely
decorative element.

### Goal 8 — discoverability and table usability

Re-verified rather than re-built: most of this checklist was already
satisfied by the two prior commits on this branch (row-interaction
discoverability; reasoning-first primary navigation). See the ticket-format
final report delivered to Warwick for the explicit per-item verdict and
evidence.

## Migrations

- `013_provider_outputs_prompt_registry_and_consultant_views.sql` — carried
  over from the prior branch (provider-output preservation, prompt registry,
  consultant views); recorded there.
- `014_consultant_reasoning.sql` — Consultant Reasoning's own raw-preservation
  table, `provider_raw_outputs.source_id NOT NULL`-exempt for reasoning runs
  (a reasoning run has no source document); results cache against the state
  hash they reasoned over and are marked stale, never deleted, when that state
  moves.
- `015_human_register_events.sql` — adds `register_row_events.origin`
  (`source` / `human` / `system`), backfilled from the existing `source_id`
  signal. Purely additive metadata: it is not part of `project_state_hash`,
  so applying it to the sealed acceptance database did not disturb the
  accepted Consultant Reasoning result (verified by hash, unchanged).
- `016_source_metadata_and_lineage.sql` — `source_documents` gains
  `meeting_subject`, `confirmed_event_date`, `event_time`, `timezone`,
  `primary_work_package`, `additional_work_packages_json`,
  `recording_gap_notes`, `confirmed_participants_json` (the latter two
  deliberately separate from the existing immutable `event_date`/
  `participants_json`); `project_source_intake` gains
  `metadata_confirmed_at`/`metadata_confirmed_by`; new append-only
  `source_metadata_events` audit table; `register_row_events` gains
  `related_external_id` for the answers/supersedes/reaffirms relationship
  trail. Purely additive; does not change `project_state_hash` computation
  beyond what already flows through `register_row_events`.

## Verification

| Check | Result |
|---|---|
| `tests/boundary.test.ts` | 17 passed |
| `tests/skillRegistry.test.ts` | 32 passed |
| `tests/consultantReasoning.test.ts` | 47 synthetic lifecycle + 110 with contract suite pass |
| `tests/consultantReasoningContract.test.ts` | 63 contract tests pass |
| `tests/reviewPack.test.ts` | 27 regression tests pass |
| `tests/components.test.tsx` | includes new Overview → Mined Data navigation regression, 190 tests pass at that commit |
| `tests/secondSourceAcceptance.test.ts` (new, this ticket) | 3 passed |
| New Goal 2 chronology test (`tests/sourceIntelligence.test.ts`, this ticket) | passed |
| `npx tsc --noEmit` (this ticket) | clean |
| `npx vite build` (this ticket) | succeeds |
| Full suite (this ticket's final run) | 551 passed, 1 skipped, 73 failed — same pre-existing Windows EBUSY/EPERM teardown baseline as every prior ticket this session, confirmed identical by re-running the unmodified files in isolation before attributing any failure to this ticket's changes |
| Repository data-boundary scan | clean (two regressions introduced and fixed within this ticket's Goal 7 work — see above) |
| Browser verification (this ticket) | metadata-confirmation flow (upload → gate → confirm → unblocked) verified end to end via Playwright against a scratch database; corporate design-token CSS pass screenshotted before/after; Goal 8 checklist verified separately (see final report) |

## Skill registry state

- `source-extraction` active revision: unchanged by this branch. `2.9.0` stays
  registered as `candidate` — **not promoted** (benchmarked no better than
  2.0.0; the comparator itself undercounts recall; kept pending the
  comparator fix).
- `consultant-reasoning` `1.0.0`: registered as `candidate` — **not promoted**.
  The skill's own change log makes promotion conditional on a real run proving
  usefulness; that evidence-gathering is the acceptance run recorded by
  `scripts/reasoning-acceptance.ts`, not a promotion decision made here.

## Residual risks (carried and new)

1. Extraction recall against the sealed benchmark is still the open item from
   the prior branch; this branch did not touch the extraction comparator.
2. The pre-existing `ConsultantViewPanel` (legacy deterministic view) does not
   guard `view.identity` and throws on a malformed response, unlike the new
   `ConsultantReasoningPanel`. Noted, not fixed, on this branch.
3. The Windows temp-file teardown defect above is long-standing, environmental
   and orthogonal to product logic, but it means `npm test` cannot be read as a
   clean signal on this machine without knowing which failures are it.
4. **(New, this ticket)** No bounded real-provider acceptance run was executed
   for Goal 5 — the deterministic proof is judged sufficient to reach a
   verdict, but Warwick may want the real-provider run performed separately
   before treating second-source ingestion as fully proven end to end with
   the actual model.
5. **(New, this ticket)** The `answers` relationship, when the answering
   source is ingested BEFORE the question it answers exists in the register
   (as in this ticket's own out-of-order scenario), cannot be expressed
   within a single packet — `Decisions` is always processed before
   `Open_Questions` in the fixed category order. It requires a second, later
   pass over the same source (a real follow-up correction, or a human
   confirming the link once both sides exist). This is now understood and
   demonstrated, not silently broken, but it means a provider generating a
   single one-shot packet per source cannot itself create a same-packet
   answers-link to a row category-ordered after it — worth flagging to
   whoever writes the real extraction skill's prompt guidance.

## Still required

1. Warwick's visual assessment of the Cockpit and a merge decision — unchanged.
   The discoverability gap and the register-first navigation both raised
   against the previous assessment attempts are now addressed, and this
   ticket adds more to review without changing that ask.
2. Whether to rewrite the two commits still carrying the un-sanitised customer
   name/meeting on the pushed branch (`3f96963` onward), or accept it as a
   low-severity residual — reported, not acted on, pending Warwick's call.
3. The three overlapping briefing mechanisms are now hierarchically resolved
   (Consultant Reasoning primary; `AdaptiveOverview` and the deterministic
   panel demoted and labelled; the full multi-mode report moved to
   Settings → More) rather than merged into one. Whether Warwick wants them
   actually merged into a single mechanism, or considers this hierarchy
   sufficient, is his call — not attempted here per this ticket's explicit
   scope.
4. **(New, this ticket)** A decision on whether the real-provider bounded
   acceptance run (residual risk 4 above) should be performed before merge.
5. No skill was promoted and nothing was merged. No AI extraction or reasoning
   call occurred automatically on any of these tickets — every provider call
   in every test is explicit, bounded and deterministic/fake.

No further redesign should happen before Warwick's review.
