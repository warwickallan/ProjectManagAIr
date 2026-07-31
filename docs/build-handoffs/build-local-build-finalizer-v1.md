# build/local-build-finalizer-v1 — the local build finaliser

**Baseline** `6de535f17ada80f8b30c92626ca10cdd1e9e2228`
**Base branch** `build/source-intelligence-acceptance-prompts-v1`
**Built by** claude-opus-5, 31 July 2026
**Verdict** COMPLETED on the build; the push, the pull request and the exact head
SHA are recorded by the finaliser's completion record and in the pull request,
because a file naming its own SHA cannot exist in the commit it names.

---

## What was built

A local build finaliser, so that turning a finished cloud build into a pushed
branch and a reviewable pull request is one action on one machine rather than a
sequence of Git commands run by hand.

Builds are produced in a cloud container that cannot reach GitHub. Before this,
each one ended with a bundle and a document, and a person then fetched, checked a
SHA, created a branch, pushed it, opened a pull request and moved deliverables
around. Every one of those steps was a place to push the wrong SHA to the wrong
branch, or to move a file somewhere it should not go.

Now a build writes a **handoff manifest** — repository, branch, baseline and
expected head SHA, a bundle, a classified deliverables list, and the path of its
own sanitised record in Git. One command reads it and finishes the job.

```
finish-projectmanagair-build.cmd
```

There is also a **Finalise** button in Settings → Build Handoffs. It calls the
same engine; there is no second implementation of any rule.

### GitHub is the canonical record

A build is COMPLETED when the branch is pushed, `ls-remote` confirms origin
points at the exact expected SHA, the draft pull request exists, and the
sanitised handoff named by the manifest is proved present **in that exact
commit** — read out of the commit's own tree, not trusted from the manifest.

Google Drive mirroring is optional. It reports `disabled`, `not_configured`,
`skipped`, `mirrored` or `failed`, and cannot change the verdict unless a
manifest explicitly opts in with `drive.required`. Nobody has to configure a
Google OAuth client to finish a build.

### What it never does

Merge. Force-push. Delete a branch. Reset or clean a working tree. Move a branch
that is not where the manifest says it should be. Commit or upload anything not
classified for that destination. Print, log or persist an access token.

A dirty or ambiguous repository fails with a readable explanation rather than a
guess. The working-tree check is deliberately narrow: an interrupted merge,
rebase, cherry-pick, revert or bisect blocks, and unmerged paths block, because
those make "what does this branch mean" ambiguous. Modified tracked files are
reported and not acted on — fetching a ref and pushing it reads no file, and a
blanket refusal would make the tool unusable on a checkout whose only sin is line
endings.

### The public-Git data boundary

This repository is public. Deliverables are classified, and the classification
decides where a file may go:

| Classification | Public Git | Drive mirror |
|---|---|---|
| `safe_for_public_git` | yes | yes |
| `safe_for_drive` | no | yes |
| `optional_private_mirror` | no | yes, when Drive is configured |
| `local_only` | no | no |
| `contains_customer_data` | no | no |
| `contains_secrets` | no | no |

There is no inferred classification. Git bundles, databases, WAL and SHM files,
raw provider output containing customer data, transcripts, credentials and local
machine configuration are never committed and never uploaded.

---

## User-visible behaviour

- **Settings → Build Handoffs** lists pending and completed handoffs. Opening the
  page is a filesystem read: it never pushes anything, never contacts GitHub or
  Drive, and never spends a network call.
- Each card shows the branch, expected and baseline SHA, whether the bundle is
  present, the local and remote branch state, the pull request, and — as the
  primary fact — whether the committed build record is present in the commit.
  The Drive mirror is shown once, labelled optional.
- **Finalise** and **Retry** run the finalisation. **Dry run** verifies and
  changes nothing, including writing no completion record.
- Failures are explained in the card, step by step, with what was attempted and
  what it did.
- The command line reports the same thing and exits `0` COMPLETED, `1` PARTIAL,
  `2` FAILED.

## Credentials

GitHub authentication comes from `git credential fill` — the same credential
`git push` already uses. No GitHub CLI, no token pasted anywhere, nothing written
to a file.

Google Drive, when used, holds a refresh token obtained through an explicit
consent flow with `state` and PKCE, written owner-only into the git-ignored
runtime directory. That refresh token is the only credential this build writes.
Everything the finaliser records passes through one redaction function before it
is written or displayed.

## Migrations

None. This build adds no schema, no table and no migration file.

---

## Verification

| Check | Result |
|---|---|
| Unit and integration tests | 457 passed, 1 skipped, 28 files |
| Finaliser tests | 45, against a real bare remote, a real bundle and a real local clone |
| TypeScript | clean (`tsc --noEmit`) |
| Production build | clean |
| Playwright end-to-end | 8 passed |
| Repository data-boundary scan | clean |

The finaliser tests use real Git throughout, with fake GitHub and Drive ports.
The Git behaviour is where a mistake destroys work, so it is exercised rather
than mocked. No network, no credentials, no model calls.

Proved by test, among others: a wrong SHA, a wrong ancestry, a wrong repository
and a look-alike host carrying the same `owner/repo` are all rejected; a build
whose sanitised handoff is missing from the commit is refused before the push; a
mid-merge repository changes nothing; a local or remote branch at a different SHA
is refused rather than force-pushed; reruns create no second pull request and no
second Drive folder; a pull request whose head has drifted is not rewritten; an
unconfigured Drive still COMPLETES; a `local_only`, `contains_customer_data` or
`contains_secrets` deliverable is never uploaded; a secret in a remote URL never
reaches the completion record.

## Adversarial review

A hostile pre-merge review of the first commit found no way to merge,
force-push, delete a branch, touch the working tree, upload a file that was not
cleared for it, or write a token into the completion record. It found twelve real
defects, all fixed with a regression test each. The two worst: a deliverable that
could not be read threw *after* the push, so no completion record was written at
all and the Cockpit reported "not pushed yet" about a branch that was on origin;
and two deliverables sharing a basename in different directories collapsed into
one Drive file, the second silently overwriting the first, with both reported as
mirrored.

Also fixed: a transient `ls-remote` failure after a successful push reported
FAILED and printed "nothing was changed"; a dry run overwrote the completion
record of the real run before it; a dry run skipped the two refusals it exists to
surface; repository identity ignored the host; a drifted pull request had its
title rewritten before its head was checked; the Drive consent flow had no
`state` and no PKCE. Six existing assertions proved less than they claimed — one
made a live network call and passed only because it failed — and were replaced.

---

## Residual risks

1. **The first finalisation is a bootstrap.** The finaliser lives on the branch
   it is pushing, so at the moment it is first needed the command is not in the
   working tree. A standalone copy under the git-ignored `.runtime\finaliser`
   handles that; the launcher walks up to find the prepared workspace. Once this
   branch is merged the command lives at the repository root and the copy can be
   deleted.

2. **The GitHub REST adapter has not run against real GitHub.** Its request
   shapes, error handling and idempotence are exercised against a local stub and
   against the fake port; the first real call happens on Warwick's machine. A
   failure there leaves the branch pushed and verified, reports PARTIAL, and is
   fixed by running the command again.

3. **`git rev-parse --verify` behaviour under `insteadOf` rewriting.** Repository
   identity reads `git config --get remote.origin.url` precisely because
   `git remote get-url` applies rewriting. An operator with an unusual rewrite
   whose configured URL is itself non-canonical would be refused rather than
   misled — the safe direction, but it is a refusal they would have to
   understand.

4. **Drive folder creation is find-then-create.** Two finalisations of the same
   build running concurrently on one machine could create two folders. Single
   operator, single command, so this is documented rather than locked.

5. **The Drive mirror in the session that produced this build was performed by a
   Google Drive connector, not by the finaliser.** The finaliser's Drive path is
   implemented and tested but needs a Desktop OAuth client the builder could not
   create. This is why Drive is optional; nothing depends on it.

## Still required

Nothing, once the finaliser has run. The build that produced this branch could
not push it — the cloud container's GitHub proxy refuses this repository, and the
bridge to the operator's machine has no network — so the push, the pull request
and the exact head SHA are produced by the one action this build exists to
provide.
