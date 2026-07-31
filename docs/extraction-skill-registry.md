# Extraction Skill Registry

The instructional text sent to the extraction model is versioned data, not code. Revisions are
registered, benchmarked, promoted, pinned and rolled back without a code change, and every pass
records which revision produced it.

Implementation: [`src/skillRegistry.ts`](../src/skillRegistry.ts), migration
[`012_skill_registry.sql`](../migrations/012_skill_registry.sql), seed assets under
[`skills/`](../skills).

## The boundary

A skill revision can change **what we ask the model for**. It can never change **what we accept
back**.

| Registry-governed (data) | Fixed in code (unreachable from the registry) |
| --- | --- |
| the instructional text sent to the provider | the strict canonical packet schema |
| which revision is in force, per project | source coverage, anchors and evidence rules |
| when a revision changed, and who changed it | packet validation and reconciliation |
| | human review and deterministic replay |

A revision that *claims* an extra row key is allowed does not make that row acceptable: the
validator never reads the registry. `tests/skillRegistry.test.ts` asserts exactly that.

## Where revisions live

```
skills/<skillId>/<version>.md          shipped seed, committed (contains no customer content)
$PROJECTMANAGAIR_SKILL_REGISTRY_DIR/<skillId>/<version>.md   private revisions, outside Git
```

The external directory **overlays** the seed — the same `(skillId, version)` replaces the shipped
one — and **extends** it with any other revision. `version` is `major.minor.patch`, compared
numerically.

Each file carries front matter, then the body:

```markdown
---
skillId: source-extraction
version: 2.1.0
promptTemplateVersion: source-extraction-prompt-v2
status: candidate
notes: Tightens the marker discharge wording after the July benchmark.
---
<the instructions sent to the model>
```

Front matter is validated strictly: an unknown key, a missing key, an unorderable version, a file
name that disagrees with its declared version, an unknown status or an empty body all fail the
whole load. A malformed revision is never silently skipped — skipping it would change which
contract the next run is graded against without anyone deciding to.

Revision bodies from the external directory are customer-adjacent: they are read to build the
prompt and hashed, and are never written to the database, logged, put in an error message or
returned from an API response. Use `publicSkillProvenance()` for anything that crosses a boundary.

## Lifecycle

```
register  →  draft / candidate  →  promote  →  active  →  retired
                     ↑                                      │
                     └──────────── rollback ────────────────┘
```

- `syncSkillRegistry(db)` registers or refreshes every revision on disk. **Registration is not
  promotion.** A file declaring `status: active` is recorded as `candidate` whenever the skill id
  already has an active revision. The one exception is bootstrap — a skill id with no active
  revision at all — and even that goes through the ordinary promotion path with actor
  `registry-bootstrap`, so it appears in the audit trail.
- `promoteSkillRevision(db, { version, actor, note })` retires the previous active revision and
  records `promoted_at`.
- `rollbackSkillRevision(db, { toVersion, actor, note })` restores a version that has been active
  before; a version that never has cannot be rolled back to.
- `pinProjectSkill` / `unpinProjectSkill` hold one project on one revision while the rest of the
  estate moves on.

The database enforces **at most one active revision per skill id** with a partial unique index, so
the invariant does not depend on every future writer remembering it. Every transition writes to
`extraction_skill_events`, which is append-only by trigger.

A revision registered once is immutable: re-syncing a file whose body hash has changed is a hard
error. Publish a new version instead.

## Provenance

Every run records: skill id, skill version, skill sha256, prompt template version, assembled prompt
sha256, provider, model, packet contract version. The frozen packet carries the same skill
provenance, so an artefact names the revision that produced it without a join through runs.

`promptTemplateVersion` versions the prompt *assembly* — which blocks appear, in what order, with
what scaffolding — separately from the skill text, so a change in behaviour can be attributed to
one or the other. Assembly is deterministic and host independent: code-unit key ordering, no clock,
no locale, no environment read.

## Re-evaluating a frozen source

`extraction_packets` is keyed `UNIQUE(project_id, packet_sha256)`, and the packet hash covers
`execution.runs`. Two passes over the same source under different skill revisions therefore produce
different run ids, different packet hashes and two coexisting packets; neither overwrites the other,
and the frozen packet stays immutable.

Note that `orchestrateSourceExtraction` deliberately refuses to re-extract a source that already
has a frozen packet, and returns the existing handoff with zero provider calls. A benchmark of a
candidate revision against already-frozen evidence is therefore a separate pass, not a re-run of the
pipeline entry point.

## Legacy single-file override

`PROJECTMANAGAIR_EXTRACTION_SKILL_PATH` still replaces the whole skill with one file. When it is in
force the run records version `0.0.0-external-file` rather than borrowing a registry version number
it does not have.

---

# Settings → AI Skills & Prompts

Migration [`013`](../migrations/013_provider_outputs_prompt_registry_and_consultant_views.sql)
extends this registry — it does not add a second one. There is one registry, one version model,
one audit trail, and one place a revision can be in force.

UI: [`src/AiSkillsPanel.tsx`](../src/AiSkillsPanel.tsx), reached from **Settings**.

## What ships

| Skill id | Name | Resolved by |
| --- | --- | --- |
| `source-extraction` | Project Source Extraction | the structured extraction pass over each source window |
| `consultant-brief` | Consultant Brief | on-demand consultant synthesis for Meeting Brief and Needs Warwick |
| `source-comprehension` | Project Source Comprehension | **nothing yet** — registered, versioned, not in force |
| `global-reconciliation` | Global Reconciliation | **nothing yet** — registered, versioned, not in force |
| `completeness-challenge` | Completeness Challenge | **nothing yet** — registered, versioned, not in force |

`SKILL_CONSUMERS` in `src/skillRegistry.ts` is the single compiled-in map of which code path
resolves which skill. It is deliberately not declarable in a revision: a revision must never be
able to claim it is in force somewhere it is not, and the page says plainly when nothing reads a
skill rather than implying the model is using it.

## The lifecycle, as an operator experiences it

1. **Read** — every registered revision, its status, SHA-256, prompt-template version, packet
   contract, recorded uses, latest benchmark and project pins. The revision text is fetched by its
   own route, so reading the model's instructions is always a deliberate act.
2. **Copy / Download** — the reusable template, as Markdown. See *What a download contains* below.
3. **Upload** — always creates a **draft**. It can never overwrite a published version and never
   activates anything. Validation checks required metadata, a supported skill id, a version that
   both is unique and increases, UTF-8 encoding, a maximum size, the placeholders the prompt
   template needs, and compatibility with the current packet-contract version. An invalid upload
   is rejected with a readable reason and nothing is written.
4. **Compare** — a longest-common-subsequence line diff between any two revisions.
5. **Publish** — a deliberate, confirmed action that moves the active-version pointer. It rewrites
   no history: the superseded revision stays registered and readable, and every past run keeps
   naming the version it actually used. The confirmation shows the currently published version,
   the candidate, the material text change, the latest benchmark, affected project pins and the
   rollback path.
6. **Roll back** — only to a version that has been active before, so a rollback cannot be used to
   slip an untested revision into production under a gentler verb.
7. **Retire** — refused for the active revision (promote or roll back instead, which retires it
   atomically) and for any revision a project is pinned to.
8. **Pin / unpin** — holds one project on one revision whatever the published version becomes.

## Where an uploaded revision is written

`$PROJECTMANAGAIR_SKILL_REGISTRY_DIR` when it is configured; otherwise the git-ignored
`/.runtime/skills/` directory. **Never** `skills/`, which is tracked by Git — an operator may
legitimately paste organisation-specific guidance into a revision, and an upload must not be able
to leak into a commit. Both directories are loaded, so an uploaded revision stays readable,
comparable and sendable afterwards.

## What a download contains

The **reusable template**: the instructions we send, written by us. It carries no customer source.

It is never the **assembled prompt**. An assembled prompt is the template plus the source windows
and the existing register rows — customer material — and only its SHA-256 is recorded, against the
run. There is no route anywhere that returns one, and `tests/promptManagement.test.ts` asserts
both halves: that an assembled prompt over synthetic customer text contains that text, and that
the downloadable template contains none of it.

## Benchmarks

`extraction_skill_benchmarks` records a graded result against the exact revision that produced it,
append-only by database trigger. A version whose score can be revised after the fact is a version
whose score means nothing. The acceptance script records one automatically, pass or fail.

## Run provenance, both directions

- run → revision: `readExtractionRunProvenance`, or `GET /api/extraction-runs/:runId/provenance`
- revision → runs: `readRunsForSkillVersion`, or
  `GET /api/extraction-skills/:skillId/versions/:version/runs`

Both cover extraction runs and consultant-brief runs, because both now record the same eight
provenance fields.
