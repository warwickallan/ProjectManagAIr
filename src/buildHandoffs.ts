/**
 * Where build handoffs live, and the read-only view the Cockpit renders.
 *
 * The Cockpit must be able to show what is pending, what happened last time and
 * what is outstanding WITHOUT touching Git, GitHub or Drive: opening a settings
 * page should never push anything or spend a network call. Everything here is a
 * filesystem read.
 *
 * The one thing the Cockpit can do that mutates is press Finalise, and that
 * calls the same {@link finalizeBuild} engine the command line calls. There is
 * no second implementation of any rule.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  COMPLETED_DIR,
  PENDING_DIR,
  discoverManifests,
  handoffLocations,
  mayBeMirroredToDrive,
  type BuildHandoffManifest,
  type FinalizeResult,
} from './buildFinalizer.js';

/** Overridable so a test, or a differently-laid-out machine, can point elsewhere. */
export const HANDOFF_ROOT_ENV = 'PROJECTMANAGAIR_BUILD_HANDOFF_DIR';

/**
 * `<repo>/../Data/staging/build-handoffs` by default — beside the Data folder the
 * rest of the project already keeps outside Git, never inside the repository.
 */
export function resolveHandoffRoot(repoRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env[HANDOFF_ROOT_ENV] ?? '').trim();
  return configured ? path.resolve(configured) : path.resolve(repoRoot, '..', 'Data', 'staging', 'build-handoffs');
}

export interface BuildHandoffView {
  manifestPath: string;
  fileName: string;
  state: 'pending' | 'completed';
  readable: boolean;
  parseError: string | null;
  modifiedAt: string;

  repository: string | null;
  branch: string | null;
  baseBranch: string | null;
  baselineSha: string | null;
  expectedHeadSha: string | null;
  origin: { model: string; session: string | null } | null;
  createdAt: string | null;
  handoffDocumentPath: string | null;

  bundlePath: string | null;
  bundlePresent: boolean;

  /** From the last completion manifest, when one exists. Never recomputed here. */
  lastRun: {
    state: FinalizeResult['state'];
    finishedAt: string;
    localHeadSha: string | null;
    remoteHeadSha: string | null;
    pullRequest: FinalizeResult['pullRequest'];
    gitHandoff: FinalizeResult['gitHandoff'];
    drive: FinalizeResult['drive'];
    deliverables: FinalizeResult['deliverables'];
    lastError: string | null;
    completionManifestPath: string;
  } | null;

  driveDeclared: boolean;
  driveFolderName: string | null;
  /** Repository-relative path of the sanitised handoff — the canonical record. */
  gitHandoffPath: string | null;
  requiredDeliverables: number;
}

function completionPathFor(manifestPath: string): string[] {
  const base = `${path.basename(manifestPath, '.json')}.completion.json`;
  const directory = path.dirname(manifestPath);
  const parent = path.dirname(directory);
  // A handoff that completed has its manifest moved to `completed`, and its
  // completion manifest is written there too; one that failed leaves both in
  // `pending`. Look in both so the Cockpit shows the last run either way.
  return [path.join(directory, base), path.join(parent, PENDING_DIR, base), path.join(parent, COMPLETED_DIR, base)];
}

function readLastRun(manifestPath: string): BuildHandoffView['lastRun'] {
  for (const candidate of completionPathFor(manifestPath)) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as FinalizeResult;
      return {
        state: parsed.state,
        finishedAt: parsed.finishedAt,
        localHeadSha: parsed.localHeadSha ?? null,
        remoteHeadSha: parsed.remoteHeadSha ?? null,
        pullRequest: parsed.pullRequest ?? null,
        // A completion record written before this field existed says nothing
        // about the canonical record — which is different from saying none was
        // declared, so it reads as unverified rather than as a refusal.
        gitHandoff: parsed.gitHandoff ?? { path: null, status: 'unverified' },
        drive: parsed.drive,
        deliverables: parsed.deliverables ?? [],
        lastError: (parsed.errors ?? [])[0] ?? null,
        completionManifestPath: candidate,
      };
    } catch {
      // A corrupt completion manifest is not worth failing a settings page over.
      continue;
    }
  }
  return null;
}

function bundleFor(manifestPath: string, manifest: BuildHandoffManifest | null): { bundlePath: string | null; bundlePresent: boolean } {
  if (!manifest?.bundlePath) return { bundlePath: null, bundlePresent: false };
  const absolute = path.isAbsolute(manifest.bundlePath) ? manifest.bundlePath : path.resolve(path.dirname(manifestPath), manifest.bundlePath);
  return { bundlePath: absolute, bundlePresent: existsSync(absolute) && statSync(absolute).isFile() };
}

/** Everything the Build Handoffs panel renders. Pure filesystem reads. */
export function readBuildHandoffs(root: string): { root: string; pending: string; completed: string; handoffs: BuildHandoffView[] } {
  const locations = handoffLocations(root);
  const handoffs = discoverManifests(root).map((entry): BuildHandoffView => {
    const manifest = entry.manifest;
    const bundle = bundleFor(entry.path, manifest);
    return {
      manifestPath: entry.path,
      fileName: path.basename(entry.path),
      state: entry.state,
      readable: manifest !== null,
      parseError: entry.error,
      modifiedAt: entry.modifiedAt,
      repository: manifest?.repository ?? null,
      branch: manifest?.branch ?? null,
      baseBranch: manifest?.baseBranch ?? null,
      baselineSha: manifest?.baselineSha ?? null,
      expectedHeadSha: manifest?.expectedHeadSha ?? null,
      origin: manifest?.origin ?? null,
      createdAt: manifest?.createdAt ?? null,
      handoffDocumentPath: manifest?.handoffDocumentPath ?? null,
      bundlePath: bundle.bundlePath,
      bundlePresent: bundle.bundlePresent,
      lastRun: readLastRun(entry.path),
      driveDeclared: Boolean(manifest?.drive),
      driveFolderName: manifest?.drive?.folderName ?? null,
      gitHandoffPath: manifest?.gitHandoffPath ?? null,
      requiredDeliverables: (manifest?.deliverables ?? []).filter((entry2) => entry2.required && mayBeMirroredToDrive(entry2.classification)).length,
    };
  });
  return { root, pending: locations.pending, completed: locations.completed, handoffs };
}

/**
 * Guard for the Finalise route: a manifest path the caller supplied must be one
 * this machine actually offers.
 *
 * The Cockpit is loopback-only, but a route that takes a filesystem path from a
 * request body and hands it to a function that runs `git push` should not accept
 * an arbitrary one.
 */
export function isKnownManifestPath(root: string, candidate: string): boolean {
  const resolved = path.resolve(candidate);
  return discoverManifests(root).some((entry) => path.resolve(entry.path) === resolved);
}
