/**
 * Renders the consultant review pack from the input that usefulness-proof.ts
 * wrote. A thin CLI: all reconciliation, sectioning and presentation lives in
 * src/reviewPack.ts, where it is covered by synthetic regression tests. No
 * database access, no provider, no model call.
 *
 * Usage:
 *   tsx scripts/build-review-pack.ts --dir <usefulness-proof out-dir>
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildReviewPack, renderReviewPack, type ReviewPackInput } from '../src/reviewPack.js';

function arg(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`--${name} is required`);
}

const dir = path.resolve(arg('dir'));
const input = JSON.parse(readFileSync(path.join(dir, 'review-pack-input.json'), 'utf8')) as ReviewPackInput;

if (input.providerCalls !== 0) throw new Error('Review pack input reports a non-zero provider call count; refusing to render.');

const markdown = renderReviewPack(input);
writeFileSync(path.join(dir, 'review-pack.md'), markdown, 'utf8');

// A short summary so the acceptance criteria are checkable from the console
// rather than only by reading the pack.
const built = buildReviewPack(input);
const counts: Record<string, number> = {};
for (const [key, entries] of built.bySection) counts[key] = entries.length;
console.log(`[review-pack] written to ${path.join(dir, 'review-pack.md')}`);
console.log(`[review-pack] records: ${input.records.length}; opening brief: ${built.topTen.length}; providerCalls: ${input.providerCalls}`);
console.log(`[review-pack] sections: ${JSON.stringify(counts, null, 2)}`);
