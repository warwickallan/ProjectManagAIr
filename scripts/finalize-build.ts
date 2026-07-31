/**
 * The command-line entry point for the build finaliser.
 *
 * Holds no Git, GitHub or Drive logic — it discovers a manifest, builds the two
 * real adapters and calls the one engine, which the Cockpit button also calls.
 *
 * Usage:
 *   tsx scripts/finalize-build.ts                       finalise the newest pending handoff
 *   tsx scripts/finalize-build.ts --manifest <path>     finalise one named handoff
 *   tsx scripts/finalize-build.ts --list                show pending and completed handoffs
 *   tsx scripts/finalize-build.ts --dry-run             verify everything, change nothing
 *   tsx scripts/finalize-build.ts --connect-drive       run the one-time Google consent flow
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  discoverManifests,
  finalizeBuild,
  newestPendingManifest,
  renderFinalizeReport,
  type FinalizeResult,
} from '../src/buildFinalizer.js';
import { GitHubRestPort, GoogleDriveRestPort, beginDriveAuthorization, driveCredentialPaths } from '../src/buildFinalizerPorts.js';
import { resolveHandoffRoot } from '../src/buildHandoffs.js';

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--') ? process.argv[index + 1] : null;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

// Normally the repository this script sits in. The first finalisation is the
// exception: the finaliser is on the branch being pushed, so a standalone copy
// runs from `.runtime/finaliser` and is told which workspace to act on.
const repoRoot = path.resolve(arg('repo-root') ?? path.dirname(path.dirname(fileURLToPath(import.meta.url))));

const handoffRoot = arg('handoff-root') ?? resolveHandoffRoot(repoRoot);

if (flag('help')) {
  console.log(readUsage());
  process.exit(0);
}

if (flag('list')) {
  const found = discoverManifests(handoffRoot);
  if (found.length === 0) {
    console.log(`No build handoffs under ${handoffRoot}.`);
  } else {
    console.log(`Build handoffs under ${handoffRoot}:\n`);
    for (const entry of found) {
      const label = entry.manifest ? `${entry.manifest.branch} @ ${entry.manifest.expectedHeadSha.slice(0, 12)}` : `UNREADABLE — ${entry.error}`;
      console.log(`  [${entry.state.padEnd(9)}] ${path.basename(entry.path).padEnd(48)} ${label}`);
    }
  }
  process.exit(0);
}

if (flag('connect-drive')) {
  const request = await beginDriveAuthorization({ paths: driveCredentialPaths(repoRoot) });
  console.log('Open this URL in a browser signed in to the Google account that owns the Drive folder:\n');
  console.log(`  ${request.authorizationUrl}\n`);
  console.log('Waiting for the authorisation to come back...');
  await request.completed;
  console.log('Google Drive is connected. Run the finaliser again to complete the pending handoff.');
  process.exit(0);
}

const explicit = arg('manifest');
const discovered = explicit ? { path: path.resolve(explicit) } : newestPendingManifest(handoffRoot);
if (!discovered) {
  console.error(`No readable pending build handoff was found under ${path.join(handoffRoot, 'pending')}.`);
  console.error('Pass --manifest <path> to finalise a specific one, or --list to see what is there.');
  process.exit(2);
}

const result: FinalizeResult = await finalizeBuild({
  manifestPath: discovered.path,
  repoRoot,
  handoffRoot,
  github: new GitHubRestPort(),
  drive: new GoogleDriveRestPort({ paths: driveCredentialPaths(repoRoot) }),
  dryRun: flag('dry-run'),
  onStep: (step) => {
    const mark = step.status === 'ok' ? 'ok  ' : step.status === 'skipped' ? 'skip' : 'FAIL';
    console.log(`[${mark}] ${step.title} — ${step.detail}`);
  },
});

console.log('');
console.log(renderFinalizeReport(result));

// A second handoff behind this one is easy to miss, and missing it is how a
// build sits unpushed for a week.
const remaining = discoverManifests(handoffRoot).filter((entry) => entry.state === 'pending' && entry.path !== result.manifestPath);
if (remaining.length > 0) {
  console.log('');
  console.log(`${remaining.length} other handoff(s) are still pending. Run this again to take the next one:`);
  for (const entry of remaining) {
    console.log(`  ${entry.manifest ? `${entry.manifest.branch} @ ${entry.manifest.expectedHeadSha.slice(0, 12)}` : `UNREADABLE — ${entry.error}`}`);
  }
}

// 0 completed, 1 partial (safe, retryable), 2 failed before any mutation.
//
// `process.exitCode`, not `process.exit()`. PowerShell runs this through a pipe,
// pipe writes are asynchronous, and `process.exit` discards whatever has not
// been flushed — which would truncate the very report the operator is told to
// read. Setting the code lets Node drain stdout and exit on its own.
process.exitCode = result.state === 'COMPLETED' ? 0 : result.state === 'PARTIAL' ? 1 : 2;

function readUsage(): string {
  return [
    'Project ManagAIr build finaliser',
    '',
    '  (no arguments)          finalise the newest readable pending handoff',
    '  --manifest <path>       finalise one named handoff',
    '  --handoff-root <path>   override the handoff directory',
    '  --repo-root <path>      act on this workspace instead of the one this script sits in',
    '  --list                  list pending and completed handoffs',
    '  --dry-run               verify everything and change nothing',
    '  --connect-drive         run the one-time Google Drive consent flow',
    '',
    'Exit codes: 0 completed, 1 partial and retryable, 2 failed before any change.',
  ].join('\n');
}
