# Finishing a build

A cloud build session can compile, test and commit, but it cannot write to the
GitHub repository. The sandboxed VM that can see the working copy has no network.
Without this layer, a build ends with a bundle on disk and a human running
`git bundle verify`, `git fetch`, `git rev-parse`, `git push` and then opening a
pull request by hand.

That is what this replaces. **One action, on Warwick's machine, finishes a build.**

```
finish-projectmanagair-build.cmd
```

No arguments: it finds the newest readable pending handoff and does the rest. The
same thing is one button in the Cockpit, at **Settings → Build Handoffs**.

Implementation: [`src/buildFinalizer.ts`](../src/buildFinalizer.ts) (the engine),
[`src/buildFinalizerPorts.ts`](../src/buildFinalizerPorts.ts) (GitHub and Drive),
[`src/buildHandoffs.ts`](../src/buildHandoffs.ts) (discovery and the Cockpit view),
[`scripts/finalize-build.ts`](../scripts/finalize-build.ts) (the CLI).

## One engine

The command line and the Cockpit button call the same `finalizeBuild`. The
PowerShell launcher finds a Node runtime and renders output; it holds no Git
logic, and neither does the UI. `tests/serverWiring.test.ts` asserts that from
the source, so a second copy of a safety rule cannot appear later without failing
the suite.

## What it does, in order

1. Read and validate the manifest.
2. Verify the repository — `origin`'s configured URL must resolve to the
   `owner/repo` the manifest names **on the host it names** (`remoteHost`,
   default `github.com`). Both halves are compared: an internal mirror or a
   look-alike host can carry the same `owner/repo`, and pushing there while
   opening the pull request against `api.github.com` would be two different
   repositories. (Configured URL, not `git remote get-url`, which applies
   `insteadOf` rewriting.)
3. Check the working tree is safe — see below.
4. Verify the bundle: `git bundle verify`, and that it carries the named branch at
   the exact expected SHA.
5. Fetch into a temporary ref — never straight onto the branch, so a branch that
   already exists somewhere unexpected is refused before anything moves.
6. Verify the expected commit is present.
7. Verify it descends from the declared baseline.
8. Create the local branch, or confirm it already points at the expected SHA.
9. Read the remote branch. A remote branch at a different SHA is refused.
10. Push with upstream tracking.
11. Verify with `ls-remote` what origin actually points at.
12. Open a draft pull request, or find and update the existing one.
13. Mirror the safe deliverables to Google Drive.
14. Write the completion manifest.
15. Upload the completion manifest into the build folder, so the record of the
    finalisation lives beside the deliverables and not only on one machine. It
    is written before it is uploaded, so the Drive copy is the one version that
    cannot name its own Drive id; the local copy is rewritten afterwards so that
    it does.

## Running it the first time

The finaliser lives on the branch it is pushing, so the very first finalisation
cannot run from the working tree — the command is not there yet. A standalone
copy is therefore delivered alongside the handoff, under
`<workspace>\.runtime\finaliser`, which is git-ignored:

```
.runtime\finaliser\finish-projectmanagair-build.cmd
.runtime\finaliser\scripts\finish-projectmanagair-build.ps1
.runtime\finaliser\scripts\finalize-build.ts
.runtime\finaliser\src\buildFinalizer.ts
.runtime\finaliser\src\buildFinalizerPorts.ts
.runtime\finaliser\src\buildHandoffs.ts
```

Double-click that `.cmd`. The launcher walks up from wherever it sits until it
finds a prepared workspace (one with `node_modules\tsx`), uses that workspace's
Node runtime and `Data` folder, and passes it to the engine as `--repo-root`.
From the repository root — which is where it lives once the branch is merged —
that walk stops immediately and behaves exactly as before.

## Choosing which handoff runs

With no arguments, the command takes the newest pending handoff **that has never
been attempted**, and only then the newest previously-attempted one. Without
that rule a handoff stuck at PARTIAL (Drive not connected, say) would be
selected forever and a second handoff behind it would never be reached. After
each run the command lists any handoffs still pending.

## What "the working tree is safe" means, and why it is narrow

Fetching a ref and pushing it does not read, write or check out a single file.
Refusing because `git status` is non-empty would be easy to write and would make
the tool unusable on a checkout whose only sin is a line-ending mismatch.

What blocks: an interrupted merge, rebase, cherry-pick, revert or bisect, and
unmerged paths in the index. Those make "what does this branch mean" ambiguous.

What is reported and not acted on: modified tracked files, untracked files, a
detached HEAD. The report names them so nothing is hidden.

## What it never does

Merge. Force-push. Delete a branch. Reset or clean a working tree. Move a branch
that points somewhere unexpected. Create a second pull request for the same head.
Write a token to disk, a log or a manifest.

## Idempotence

Every step reads the current state before it writes, so re-running is safe:

- an already-pushed branch skips the push;
- an existing pull request is confirmed, or updated in place if the title or body
  moved on — never duplicated;
- an existing Drive build folder is reused, matched on branch plus exact SHA;
- a completed handoff performs no mutation at all on a second run.

## The three outcomes

| | |
|---|---|
| **COMPLETED** | Branch pushed, remote SHA verified, draft pull request in place, every required safe deliverable mirrored. The manifest moves to `completed/`. |
| **PARTIAL** | The Git side finished safely. Something after it is outstanding — GitHub was unavailable, Drive is not connected, a required upload failed. The manifest stays in `pending/`, and re-running retries only what is outstanding. |
| **FAILED** | A safety check failed before anything was changed. Nothing was pushed and nothing was created. |

A Drive failure never undoes a successful push. That ordering is deliberate: the
push is the expensive, irreversible half.

## Where handoffs live

```
Data\staging\build-handoffs\pending\<name>.json               waiting
Data\staging\build-handoffs\pending\<name>.completion.json    the last run, when it did not complete
Data\staging\build-handoffs\completed\<name>.json             done
Data\staging\build-handoffs\completed\<name>.completion.json  the record of it
```

Outside Git, beside the `Data` folder the rest of the project already uses.
Override with `PROJECTMANAGAIR_BUILD_HANDOFF_DIR`.

## The manifest

```jsonc
{
  "manifestVersion": 1,
  "repository": "owner/repo",
  "remoteHost": "github.com",                        // optional; origin must be on this host
  "bundlePath": "../source-intelligence-v1.bundle",   // or null when the branch is already on origin
  "branch": "build/example-v1",
  "baseBranch": "main",
  "baselineSha": "<40 hex>",
  "expectedHeadSha": "<40 hex>",
  "pullRequest": { "title": "…", "bodyPath": "./handoff.md", "draft": true },
  "createdAt": "2026-07-31T12:00:00.000Z",
  "origin": { "model": "claude-opus-5", "session": "…" },
  "handoffDocumentPath": "…/F247_…_Handoff.md",
  "deliverables": [
    { "path": "…/handoff.md", "classification": "safe_for_drive", "required": true, "googleDoc": true },
    { "path": "…/transcript.vtt", "classification": "contains_customer_data", "required": false }
  ],
  "drive": { "folderId": "…", "folderName": "ProjectManagAIr", "buildDeliverablesFolder": "Build Deliverables" }
}
```

Paths may be absolute or relative to the manifest. `drive: null` skips mirroring.

## Authentication

**GitHub** — `git credential fill`, which is whatever already authenticates
`git push` on that machine. No GitHub CLI to install, no token to paste. If push
works, the pull request works.

**Google Drive** — a one-time consent. It needs a Desktop OAuth client saved at
`config/google-drive.local.json` (already covered by `.gitignore`), then
**Connect Google Drive** in the Cockpit or `--connect-drive` once. The refresh
token is written to `.runtime/`, outside Git.

Where Drive is not connected, the Cockpit says **Google Drive connection
required** and offers one button. Retry then completes the same handoff without
anyone finding the files again.

Tokens are never printed, logged or persisted by this code. Everything the
finaliser records passes through one redaction function first, and the test suite
proves a token embedded in a remote URL does not reach the completion manifest.

## The data boundary

Only `safe_for_drive` uploads. `contains_customer_data`, `contains_secrets` and
`local_only` stay on the machine — recorded in the completion manifest with their
hashes, so what was withheld is visible.

Never uploaded merely because they sit beside a handoff: customer source
documents, transcripts, email content, databases and their WAL and SHM files, raw
provider outputs, Git bundles, credentials, local configuration, unredacted logs.

A builder that does not classify a file gets no upload. The default is to
withhold.

## Other commands

```
finish-projectmanagair-build.cmd --list             what is pending and completed
finish-projectmanagair-build.cmd --dry-run          verify everything, change nothing
finish-projectmanagair-build.cmd --manifest <path>  finalise one named handoff
finish-projectmanagair-build.cmd --connect-drive    the one-time Google consent
```

Exit codes: `0` completed, `1` partial and retryable, `2` failed before any
change, `3` the workspace is not ready.
