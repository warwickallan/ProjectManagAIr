# Consultant views

Meeting Brief and Needs Warwick, and the on-demand synthesis over them.

Implementation: [`src/projectThemes.ts`](../src/projectThemes.ts),
[`src/consultantViews.ts`](../src/consultantViews.ts),
[`src/ConsultantViewPanel.tsx`](../src/ConsultantViewPanel.tsx).

## The cost rule

Opening a project, changing a tab, changing a filter, refreshing the page, viewing a row, or the
deterministic selection changing all cost **zero provider calls**. A synthesis happens when, and
only when, the consultant presses **Generate consultant view** or **Refresh consultant view**. One
press produces at most one bounded provider call.

This is a wiring property before it is anything else, and `tests/serverWiring.test.ts` asserts it
from the source: the GET route reaches `readConsultantView` and cannot reach
`generateConsultantView`, and `src/db.ts` — which is what opening a project runs — builds the
deterministic views and nothing else.

## Deterministic themes

The register tabs stay the granular evidence layer. AI is not used to reproduce or sort register
rows; grouping them is answerable from structure the project already holds.

Edges, strongest first:

| Kind | Evidence |
| --- | --- |
| `related-id` | a row names another as related |
| `supersession` | a row supersedes another |
| `work-package` | both sit in the same work package |
| `entity` | both name the same registered entity or alias |
| `shared-source-passage` | both are anchored within six segments of each other in the same source |
| `distinctive-title` | Dice ≥ 0.6 on ≥ 2 shared tokens, **and** at least one shared token that is rare across this project's own rows |

That last condition is the whole guard. Every register row in an implementation project says
"data", "system", "customer", "update"; a grouping built on those is worse than no grouping,
because it reads as insight. Document frequency is computed from the project, so a word that is
generic *here* cannot join two records however unusual it is in English. A token has to appear in
three or more rows before it counts as generic — two rows sharing "permit escalation" is the
normal shape of a real theme, not noise.

Rows that belong to no theme are reported as ungrouped. Nothing is forced into a theme.

Each theme reports its member ids, every reason it holds together, its register counts,
unresolved decisions, blocking and overdue counts, whether it carries a customer dependency, and
its source-anchor count.

## The deterministic views

**Meeting Brief** — themes to challenge, customer-owned blockers, decisions needed, unresolved
questions, high risks and issues, milestones at risk, relevant recent changes.

**Needs Warwick** — ranked consultant actions, decisions requiring Warwick, conflicts, overdue
items, uncertain items needing judgement, high-leverage items that unlock several dependent
records.

"Unlocks" is deterministic and conservative: only open, non-decision records inside the same
theme count.

## The synthesis, and its cache

The evidence pack is the themes plus up to 40 selected records. The prompt is the published
`consultant-brief` revision plus that pack; it refuses over 12,000 tokens rather than truncating
the evidence.

The cache key is the SHA-256 of the deterministic selection **plus** the skill id and version, the
prompt-template version, the provider, the model and the packet-contract version. Two views that
differ in any of those are different artefacts and cache separately — a cache that could not tell
them apart would serve one while reporting the other's provenance.

Every factual line must cite selected register ids. A narrative that fails citation validation is
discarded, not shown with its unsupported lines removed and its provenance intact.

## Staleness is not regeneration

When the selection moves, the previous synthesis is kept, marked stale, and given a reason a
consultant can read. Applying a changeset does the same for every cached view of that project.
Nothing regenerates on its own: spending tokens because state changed is exactly the automatic
behaviour this design rules out.

## When the provider fails

The deterministic view stands and is never relabelled as generated. The failure is shown with a
recovery action, the previous synthesis (if any) stays on screen and stays labelled stale, the
attempt is recorded once in `consultant_brief_runs`, and nothing retries. A second attempt is a
second deliberate press.
