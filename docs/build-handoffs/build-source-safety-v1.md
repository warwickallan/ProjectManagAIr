# build/source-safety-v1 — every uploaded transcript as a reversible source transaction

**Baseline** `ec37537081702644a142d4cfcc17a6330b9dba9c` (build/source-intelligence-usefulness-v1)
**Head** `d222df1` — see the commit table below
**Built by** claude-opus-5, 1 August 2026
**Verdict** PENDING WARWICK'S ASSESSMENT — built, tested and browser-verified;
**nothing merged, no skill promoted, no history rewritten, no provider call made.**

This branch answers the source-safety inspection recorded at the end of
`build-source-intelligence-usefulness-v1.md`. All four findings there are now
implemented.

## Commits

| Commit | What |
|---|---|
| `9ea7e43` | Migration 017 and the deterministic services: chronology, content identity, discard, void, replay exclusion, routes |
| `32b8ec4` | 43 synthetic acceptance tests across three suites |
| `d222df1` | Inbox chips, source record panel, chronology control, and one pre-existing false-failure notice fixed |

## The silent correctness bug this removes

`confirmSourceMetadata` hard-required a `YYYY-MM-DD` meeting date, so a
consultant holding a Teams export with no reliable header had to type one. The
typed value was then **ignored**: `humanPrecedenceInstant` read the immutable,
evidence-derived `source_documents.event_date`, which is NULL for a real Teams
export, and fell back to `created_at`. Meeting precedence silently became upload
order, and a source could outrank an earlier meeting purely by arriving second.

Upload time now appears nowhere in the precedence path.

## Chronology (`src/sourceChronology.ts`)

State, precision and basis are stored **separately from the value**, so "3
August, certain", "some time in August" and "genuinely unknown" are different
records rather than one nullable column.

- `chronology_state` — `confirmed` | `approximate` | `unknown`
- `chronology_precision` — `exact-datetime` | `date` | `month` | `range` | `none`
- `chronology_basis` — `human-confirmed` | `transcript-header` |
  `filename-suggestion` | `file-timestamp-suggestion` | `absent`

Ordering is **interval-based with strict separation only**: `a` is before `b`
only when a's interval ends before b's starts. Overlapping intervals, identical
days, and anything involving an unknown date all return `unresolved` and are
held for review as **Chronology unresolved**, never guessed. Two exact datetimes
on one day *do* order.

Human-edit precedence keeps its own, deliberately different rule: an
unknown-date source returns the start of time, so any human edit outranks it.
That is the conservative answer and it protects a human correction from being
reverted by an undateable transcript without inventing a date for it.

Meeting subject and primary work package stay mandatory. The date must be
**answered** — including by explicitly choosing Unknown — but never invented; a
caller supplying neither a date nor a state is refused rather than defaulted.
`normaliseChronology` refuses to store a `*-suggestion` basis as `confirmed`.

A transcript's own `NOTE Recorded:` header is treated differently from a
filename: it is evidence carried by the source, so intake seeds it as
`approximate`/`transcript-header`, which a human confirmation overrides and
audits. Every chronology change writes one `source_metadata_events` row per
changed field.

## Content identity (`src/sourceIdentity.ts`)

Three deterministic layers, all computed **before any provider call**:

1. **raw SHA-256** — byte identity.
2. **canonical fingerprint** — SHA-256 over the transcript reduced to speaker
   and dialogue content: line endings and Unicode normalised, WEBVTT headers,
   NOTE blocks, cue identifiers, timestamps and inline cue tags removed,
   whitespace collapsed. WebVTT `<v Speaker>` voice tags are rewritten to
   `Speaker: ` rather than stripped, because exporters differ on which form they
   use and the two must canonicalise identically.
   Deliberately **not** lowercased or punctuation-stripped: two different
   meetings on one subject share far too much vocabulary for that to be safe.
3. **chunk fingerprints** — overlapping 3-line windows, stride 1. Overlap is
   **containment within the smaller set**, not symmetric Jaccard: a short partial
   transcript inside a long meeting scores ~0.1 on Jaccard and 1.0 on
   containment, and containment is the signal.

Classification: `exact-duplicate`, `normalised-duplicate`, `possible-overlap`,
`similar-filename-different-content`, `previously-voided-duplicate`,
`cross-project-match`, `apparently-new`. Exact, normalised and previously-voided
duplicates **block** before AI; possible overlap is **held** for confirmation;
a similar filename alone never establishes duplication; the meeting date is not
part of identity; the same content on another project **warns, never blocks**,
because one source can legitimately relate to more than one project.

## Discard and void (`src/sourceSafety.ts`)

**Discard** (before application) — `duplicate` | `wrong-project` | `wrong-file` |
`discarded`. Preserves the immutable file, both hashes, the fingerprints and all
provenance; records actor, time and a mandatory reason; closes off unapplied
changesets; mutates no register state; calls no provider. **Refuses outright
once a changeset has been applied** and points at Void. Deliberately distinct
from the pre-existing "skip because no governance content" operation: a skipped
source belonged here and had nothing to mine; a discarded source never belonged.

**Void** (after application) — a **replay-time exclusion, never a compensating
write**. A compensating write would land at void-time, after every later valid
source and human edit, and would silently overwrite them. `rebuildProjection`
excludes exactly the events the contract names (`origin = 'source'` AND
`source_id` = the voided source), retains human events and every other source's
events, then marks Consultant Reasoning stale. Evidence, packets, raw responses,
changesets and review decisions are all retained and marked, never deleted, and
retired identifiers are never reused.

### The dependency rule

Implemented in `voidDispositionFor` (in the projection, because it is a property
of the replay):

- **Rule A** — a still-valid source independently evidences the row (at least
  one anchor of its own whose quote was **mechanically verified**), or the row
  carries human events: **retained**, effective state re-anchored to the valid
  source, flagged `founding-source-voided` — *"Founding source voided — review
  required"*.
- **Rule B** — otherwise: **leaves effective state**, retained in history,
  flagged `orphaned-by-source-void` — *"Orphaned by source void — review
  required"*. It is removed from its operational table via the same path a row
  leaving the register already takes, references repaired.
- Surviving rows whose relationship counterpart (`answers`, `answered_by`,
  `supersedes`, `superseded_by`, `resolves`, `reaffirm`, `contradicts`) was
  removed or altered are flagged `relationship-review`. Relationships are never
  silently repaired or deleted.

**Known limit, stated rather than papered over.** A verified quote proves the
words were said in that meeting, not that they were said *independently*. A
later source reading a prior decision aloud verbatim is indistinguishable, to
any deterministic rule, from one that reached it on its own. The rule therefore
errs toward **retaining and flagging**, because wrongly retaining a row a human
must review is recoverable while wrongly removing one is the silent data loss
this design exists to prevent. Both outcomes are flagged; neither is silent.

## Gate

`runSourceExtractionJob` — the single function all three intake triggers funnel
through — now refuses a **retired** source and refuses one whose **blocking
duplicate verdict nobody has decided**, both ahead of the existing metadata gate.
New statuses: `source-retired`, `awaiting-duplicate-decision`.

## Migration 017

`source_documents` gains chronology state/precision/basis/range,
`canonical_fingerprint`, and lifecycle state/reason/actor/at/`duplicate_of_source_id`.
`project_source_intake` gains `canonical_fingerprint` and `lifecycle_state`.
`register_changesets` gains `voided_at`/`voided_by`/`void_reason`.
`register_row_state` gains `effective`/`review_flag`/`review_detail` (derived,
recomputed on every replay). New tables: `source_chunk_fingerprints`,
`source_alternate_names`, `source_comparisons`, `source_lifecycle_events`
(append-only, trigger-enforced). Purely additive; existing rows with a confirmed
date are backfilled to `confirmed`/`human-confirmed`, everything else to
explicitly `unknown` rather than silently inheriting `created_at`.

## UI

Inbox rows carry three chips (duplicate verdict, decision-owed, chronology
state) resolved server-side in the project payload, so nothing must be opened to
see them. "Meeting date unknown" is shown even when all is well, because it is a
legitimate permanent state. The source record shows identity and every
alternative filename, the full comparison table, extraction and changeset
history with void marks, register rows created or affected with their
effective/historical state and review flag, the append-only lifecycle history,
and the governed actions. Discard and Void each need an explicit arm step plus a
mandatory reason.

The meeting-details form now asks *when did this meeting happen* — know the
date / know roughly when / unknown — with labelled date suggestions that are
never auto-applied.

**One pre-existing defect fixed, in scope:** every newly uploaded source rendered
the failure notice ("This source reported a problem while processing… the
pipeline recorded no error detail for this failure"). Awaiting metadata sets
`needsAttention` correctly, but the notice treated that as failure. Awaiting
metadata now renders its own calm notice; genuine failures are untouched.

## Verification

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx vite build` | succeeds |
| `tests/sourceIdentity.test.ts` | 13 passed |
| `tests/sourceChronology.test.ts` | 17 passed |
| `tests/sourceSafety.test.ts` | 13 passed |
| Repository data-boundary scan | clean |
| Full suite | 596 passed, 1 skipped, 73 failed — 553 prior baseline plus 43 new; failure count and file set identical to the established Windows EBUSY/EPERM teardown baseline |
| Browser (scratch database) | all chips, comparison table, fingerprints, lifecycle history, decision form and unknown-date control render; **zero non-GET requests** across the whole inspection |

Browser evidence is at `artifacts/source-safety-ui-check.mjs` and
`artifacts/source-safety-{inbox,source-record,chronology}.png`. `artifacts/` is
git-ignored, so these live outside the repository by existing convention.

Three real defects were found by writing the tests: the voice-tag speaker-name
loss, the chunk window that hid overlap in short transcripts, and the dependency
rule's discriminator needing to be stated honestly.

## Treatment of the already-known source

`SRC-001` (SHA-256 `4c67ed61…ee208f`) is untouched. It was not re-extracted, not
re-ingested and not migrated into any new state beyond the additive backfill:
it has no confirmed date, so it reads as `chronology_state = 'unknown'`, which
is the honest answer. It has no successful extraction, no changeset and no
applied register events, so it is `canDiscard: true` / `canVoid: false` and the
UI offers retain/discard only. The other inspected hash (`ee5d3018…fabf096`)
remains unknown to the system; **neither real VTT was ingested during this
ticket.**

## Remaining limitations

1. The void dependency discriminator cannot distinguish independent evidence
   from a verbatim reference (documented above). It errs toward retain-and-flag.
2. `possible-overlap` thresholds (0.25 review, 0.9 containment) are judgement
   values validated against synthetic fixtures only; they have never been run
   against two real transcripts.
3. Canonicalisation is tuned for VTT. TXT and EML sources are canonicalised by
   the same function and will work, but their formats have not been exercised.
4. Un-void is not implemented. A void can be reversed only by a new source or a
   human event, not by a single action.
5. Cross-project duplicate detection warns but has no "link these projects to
   one source" concept.
6. No real-provider run has been executed on this branch, by instruction.
7. The Windows EBUSY/EPERM teardown failures remain, untouched by instruction.

## Still required

1. Warwick's assessment and a merge decision. Nothing is merged.
2. The branch-history correction for the customer-specific text in `3f96963`
   onward, still outstanding from the previous branch and deliberately not
   attempted here.
3. A decision on whether to run the bounded real-provider acceptance with the
   two real VTTs now that duplicate detection, unknown-date handling and void
   exist to make it safe.
