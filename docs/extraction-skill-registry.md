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
