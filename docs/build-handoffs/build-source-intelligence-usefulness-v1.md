# build/source-intelligence-usefulness-v1 — two-intelligence architecture, Consultant Reasoning, usefulness proof

**Baseline** `6de535f17ada80f8b30c92626ca10cdd1e9e2228` (build/source-intelligence-acceptance-prompts-v1)
**Head** `53d34b16ec5677edd02e354dd86030b09f0745e7`
**Built by** claude-opus-5, 31 July – 1 August 2026
**Verdict** PENDING WARWICK'S VISUAL ASSESSMENT — everything below is built and
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
in place ("the NPL PPM Playback meeting" → "a live customer project meeting"),
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

## Migrations

- `013_provider_outputs_prompt_registry_and_consultant_views.sql` — carried
  over from the prior branch (provider-output preservation, prompt registry,
  consultant views); recorded there.
- `014_consultant_reasoning.sql` — Consultant Reasoning's own raw-preservation
  table, `provider_raw_outputs.source_id NOT NULL`-exempt for reasoning runs
  (a reasoning run has no source document); results cache against the state
  hash they reasoned over and are marked stale, never deleted, when that state
  moves.

## Verification

| Check | Result |
|---|---|
| `tests/boundary.test.ts` | 17 passed |
| `tests/skillRegistry.test.ts` | 32 passed |
| `tests/consultantReasoning.test.ts` | 47 synthetic lifecycle + 110 with contract suite pass |
| `tests/consultantReasoningContract.test.ts` | 63 contract tests pass |
| `tests/reviewPack.test.ts` | 27 regression tests pass |
| `tests/components.test.tsx` | includes new Overview → Mined Data navigation regression, 190 tests pass at that commit |
| Full suite (this session) | 528 passed, 1 skipped, 73 failed — every failure is `EBUSY`/`EPERM` unlinking a temp SQLite file or creating a symlink without elevation, a pre-existing Windows-only teardown defect verified identical at the pre-build baseline (recorded in commit 83ee553); no failure touches skill-registry, boundary or consultant-reasoning content |
| Repository data-boundary scan | clean after the correction above |

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

## Still required

Warwick's visual assessment of the Cockpit (Overview led by Consultant
Reasoning, Mined Data tab, evidence drill-down, both skill families in
Settings → AI Skills & Prompts) and a merge decision. No further AI extraction
or reasoning call, no skill promotion and no redesign should happen before
that review.
