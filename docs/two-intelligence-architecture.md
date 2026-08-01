# The two-intelligence architecture

Project ManagAIr uses **two** AI skills with opposite jobs, and a deterministic
layer between them that neither one can bypass.

```
  a source                                        the consultant
     │                                                   ▲
     ▼                                                   │
┌─────────────────────┐                     ┌────────────────────────┐
│ SOURCE INTELLIGENCE │  mines              │  CONSULTANT REASONING  │  explains
│  source-extraction  │  ───────────┐       │  consultant-reasoning  │
└─────────────────────┘             │       └────────────────────────┘
                                    ▼                    ▲
                        ┌───────────────────────────────────────────┐
                        │           PROJECT MANAGAIR                │
                        │  validate · review · apply · version ·    │
                        │  preserve · cache · resolve evidence      │
                        │              (SQLite)                     │
                        └───────────────────────────────────────────┘
```

**Granularity is desirable during extraction. Compression is desirable during
reasoning.** Neither layer is asked to do the other's job. The mined records are
project *memory*; they are not the dashboard's answer.

## Why two skills and not one

A single pass that both reads a transcript and writes a consultant briefing has
to choose between two incompatible objectives on every line: preserve the detail
so nothing is lost, or drop the detail so the result is readable. It resolves
that tension by inventing — smoothing several half-remembered fragments into one
confident sentence that no single record supports.

Splitting the pass makes each objective unambiguous and, more importantly, puts a
**deterministic checkpoint** between them. Extraction output is validated,
reviewed by a human and applied before reasoning ever sees it, so the reasoner
works from approved state rather than from a model's impression of a transcript.

## The two families

|  | Source Intelligence | Consultant Reasoning |
|---|---|---|
| Skill id | `source-extraction` | `consultant-reasoning` |
| Reads | one normalised source, windowed | the complete approved register |
| Writes | typed register *proposals* | an advisory reasoning artefact |
| Mutates state | yes, after human review/apply | **never** |
| Cites | verbatim transcript quotes | register IDs only |
| Triggered by | the folder watcher, automatically | Warwick, explicitly |
| Output contract | packet → changeset | strict JSON, `ReasoningOutput` |

### The citation asymmetry is the point

Source Intelligence must anchor every factual row to a **verbatim quote** from
the source, because it is the only layer that has seen the source.

Consultant Reasoning is **forbidden** from quoting or rewriting transcript
evidence. It cites register IDs; Project ManagAIr resolves those IDs to the
canonical anchors stored at extraction time
(`src/consultantReasoningRender.ts`). A fabricated quote in a consultant brief is
therefore not a risk that has to be detected — it is unrepresentable, because the
reasoning model never supplies quote text at all.

## The flow

1. Warwick drops a source into `<project>\00_Inbox\Unsorted`.
2. The watcher ingests it and normalises it into segments, windows and markers.
3. Source Intelligence runs against the project's **resolved** extraction
   revision. It never falls back to a hidden or unversioned prompt.
4. The raw provider response is preserved **before parsing**; the packet is
   validated and frozen into a reviewable changeset.
5. A human reviews and applies. Only now does approved state change.
6. Approved state changing marks any cached reasoning **stale** — not deleted.
7. Warwick explicitly selects **Generate** or **Refresh**.
8. One bounded Consultant Reasoning call runs against the resolved reasoning
   revision.
9. The complete raw response is preserved **before parsing**.
10. Deterministic validation checks the output contract and every cited register
    ID against the IDs actually supplied.
11. The accepted result is cached and displayed until project state or
    generation context changes.

**Opening, navigating or reopening the Cockpit makes zero provider calls.** That
is a structural property of `readConsultantReasoning`, which returns
`providerCallsThisRequest: 0` and has no path to a provider. Generation is POST
only, so token spend is never a side effect of navigation.

Reasoning is **not** invoked automatically after an extraction or an apply. A
newly applied changeset makes the brief stale and says so; it does not spend
tokens on Warwick's behalf.

## What the deterministic layer enforces

A skill revision may change what the AI is *asked* to do. It must never weaken
what Project ManagAIr *accepts*. Every rule below lives in
`src/consultantReasoningContract.ts` as code, not in the prompt as a request:

- unknown or invented register IDs — anywhere, including `state_observations`
  and `limitations`;
- unknown top-level or per-matter fields;
- invalid enum values for classification, priority, state, owner class and
  evidence strength;
- duplicate or malformed matter IDs;
- section arrays referencing matters the output never defined, or listing one
  twice;
- `brief_type` disagreeing with the requested mode;
- more than 25 matters, more than 10 in the meeting order, an executive summary
  outside 2–5 points;
- a **customer dependency** that is neither customer-owned nor classified as
  one — the failure that put the consultant's own work in front of the customer;
- a **consultant action** that is neither consultant-owned nor shared nor an
  explicit ownership-resolution move — the failure that silently turns unowned
  work into Warwick's;
- a **stale, conflicted or weakly supported matter** missing from
  `confirmation_warnings` — the failure that presents history as current truth.

Validation collects *every* violation rather than stopping at the first, and
there are **no retries**. A completed response that fails to parse or validate is
preserved, recorded with its violations, and surfaced. Re-buying the same tokens
to get a second opinion on our own prompt is how a budget disappears without
anyone deciding to spend it.

## Provenance and preservation

Every reasoning run records: skill ID and version, prompt-template version, skill
and prompt SHA-256, provider and model, project-state hash, register revision,
request context, timing, token counts (labelled `estimated` when the CLI reports
none), the raw-output reference, the parse and validation outcome, the accepted
result hash, and the provider-call count.

Raw responses live in `consultant_reasoning_raw_outputs`. Reasoning needed its
own table because `provider_raw_outputs.source_id` is `NOT NULL` and a reasoning
run has no source document.

## Cache and staleness

The cache key covers project, project-state hash, mode, skill ID and version,
prompt-template version, provider and model. Anything that could change the
answer changes the key.

The project-state hash covers exactly the register content the model is shown, so
a change it could not see cannot invalidate its answer, and one it could see
must. Superseded results are marked stale and **kept** — the previous brief is
how you see what changed.

## Where things live

| Concern | Module |
|---|---|
| Complete-state assembly and hashing | `src/consultantReasoningState.ts` |
| Output contract and validator | `src/consultantReasoningContract.ts` |
| Skill resolution, one bounded call, cache | `src/consultantReasoning.ts` |
| The headless CLI provider | `src/consultantReasoningProvider.ts` |
| Register-ID → canonical evidence, markdown | `src/consultantReasoningRender.ts` |
| Schema | `migrations/014_consultant_reasoning.sql` |
| The skill body | `skills/consultant-reasoning/1.0.0.md` |

Both families are managed from **Settings → AI Skills & Prompts**, which is
generic over `skillId`: view, compare, upload a draft, validate, publish, retire,
roll back, pin per project, and inspect the audit trail and run provenance. The
skill body is never hardwired into provider code.

## The deterministic fallback

`src/reviewPack.ts` and `src/consultantViews.ts` remain, at zero provider calls,
as the **fallback and evidence browser** — not as the primary answer. The
reasoning skill is explicitly forbidden from being handed the deterministic
top-40 selection or a pre-written review pack in place of the project state; that
substitution is what the whole second intelligence exists to avoid.

## Status

`consultant-reasoning` 1.0.0 ships as a **candidate**. Its own change log makes
promotion conditional on a real project-state run demonstrating concise,
accurate, source-grounded consultant usefulness. Resolution therefore falls back
to the highest candidate when no active revision exists — without that, the
family would be unusable until someone promoted it blind, which is exactly the
decision the candidate status exists to defer.
