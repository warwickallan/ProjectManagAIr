# build/source-intelligence-acceptance-prompts-v1 — source intelligence acceptance, prompt management, consultant synthesis

**Baseline** `897a5e5a16540460927f06a12d16e3b0fdf9a2af`
**Head** `6de535f17ada80f8b30c92626ca10cdd1e9e2228`
**Built by** claude-opus-5, 31 July 2026
**Verdict** PARTIAL — everything built, tested and verified; the governed
extraction acceptance **failed its target and was reported rather than tuned**.

This record was written after the fact, on `build/local-build-finalizer-v1`,
because the standing order that requires a committed build record did not exist
when this build was made. Its commits are ancestors of that branch, so both
builds arrive in one pull request.

---

## What was built

**Provider-output preservation.** Every raw provider response is persisted the
moment it is received — before JSON parsing, schema validation, row
canonicalisation, merging, client-reference resolution or packet assembly. The
table is immutable by trigger except for the fields that record what parsing
later made of it. A preserved response can be replayed, so an extraction run can
be re-analysed without spending another model call and without the original
being lost to a parser change.

**Prompts and skills as managed data.** Settings → AI Skills & Prompts extends
the existing skill registry — there is no second registry. It lists every skill
and version, shows a revision's text, downloads it, accepts an uploaded draft,
compares two versions, validates, publishes, rolls back, retires and pins.
Which parts of a prompt are fixed by the application and which are editable is
displayed rather than assumed. Provenance runs both ways: a run names the skill
version that produced it, and a skill version lists the runs that used it.

**Deterministic consultant views.** Thematic grouping is deterministic — union-find
over shared terms with a document-frequency guard so a term common to everything
cannot bind unrelated items together. The Meeting Brief and the Needs Warwick
view make **zero** model calls and are complete without a provider. Consultant
synthesis is on demand only, behind an explicit Generate or Refresh, cached on
selection plus skill, prompt, provider, model and contract version. Staleness is
shown; nothing regenerates itself. When a provider fails, the failure is
reported as a failure and the deterministic view is never dressed up as
generated output.

## The governed acceptance, and why it is a PARTIAL

One governed extraction acceptance was run against a fresh copy of the live
database with the currently published extraction skill, the real provider, and a
sealed benchmark. No prompt or skill was changed during the run.

**Distinct-fact recall: 9.4% against a 70% target.**

The run was preserved, the changeset was left unapplied, and nothing was tuned
and re-run. No comparison threshold was moved to reach the target. That number
is the honest baseline this work now has to improve on, and it is the most
useful thing in this record.

After the adversarial review below produced fixes, the acceptance evidence was
re-verified: the extraction-path files were diffed and the frozen packet
re-checked at the new head, giving an identical deterministic hash and identical
metrics. The failure is a real property of the current prompt, not an artefact.

## Migrations

`migrations/013_provider_outputs_prompt_registry_and_consultant_views.sql` —
adds `provider_raw_outputs` (immutable by trigger except `run_id`,
`parse_status`, `parse_detail`; deliberately no delete trigger, to avoid
repeating a known cascade defect), registry columns, an append-only
`extraction_skill_benchmarks` table, provenance columns on
`consultant_brief_runs`, and rebuilds `consultant_briefs` with a uniqueness
constraint on project, mode and cache key.

## User-visible behaviour

- Settings gains **AI Skills & Prompts**: browse, read, download, upload a
  draft, compare, validate, publish, roll back, retire, pin.
- An uploaded skill is always written as a draft and never overwrites an
  existing version; the published pointer only moves on an explicit publish.
- Project overview gains **Meeting Brief**, **Needs Warwick**, and a
  **Consultant reasoning** panel with an explicit Generate button that states it
  makes at most one bounded model call.
- With no provider on the machine, everything deterministic still works, and the
  download says plainly "Generated reasoning: none".

## Data boundary

A historical run's fully assembled prompt can contain customer source windows.
It is labelled as potentially containing customer data, is never committed, and
is excluded from ordinary prompt downloads. Customer source text and assembled
source-containing prompts are never included in a normal download.

## Verification

| Check | Result |
|---|---|
| Unit and integration tests | 441 passed, 1 skipped, 27 files at that head |
| TypeScript | clean |
| Production build | clean |
| Playwright end-to-end | 8 passed |
| Database integrity, live parity on a copy | verified |
| Repository data-boundary scan | clean |

## Adversarial review

Two independent hostile reviews found twenty verified defects, including a
critical one where the preserved-output primary key omitted the attempt number
and therefore threw **from inside preservation itself** — the one place a
failure is least acceptable. Every critical, high and medium finding was fixed
with a regression test.

## Residual risks

1. **Extraction recall is 9.4%, not 70%.** The pipeline, the preservation and
   the benchmark are sound; the prompt is not yet good enough. This is the open
   item.
2. **The consultant synthesis cache key is wide.** It includes provider and
   model, so a provider upgrade invalidates every cached brief. That is correct
   and it will look like a mass regeneration prompt the first time it happens.
3. **`provider_raw_outputs` has no delete trigger.** Deliberate, to avoid a
   known cascade defect. Retention is therefore a policy question, not an
   enforced one.

## Still required

Improve extraction recall against the sealed benchmark, and re-run the governed
acceptance. Nothing else about this build is outstanding.
