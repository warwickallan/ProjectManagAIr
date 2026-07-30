import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WatchedInboxScanner,
  defaultExtractionBudget,
  planExtractionSlices,
} from '../src/sourcePipeline';
import type { ExtractionWindowInput } from '../src/extractionProvider';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'projectmanagair-watch-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

function window(seq: number, tokenEstimate: number): ExtractionWindowInput {
  return {
    id: `source:window:${seq}`,
    seq,
    startSeq: seq,
    endSeq: seq,
    tokenEstimate,
    segments: [{ seq, text: `Synthetic segment ${seq}`, speaker: null, tStartMs: null }],
  };
}

describe('source extraction planning', () => {
  it('packs windows into bounded calls without crossing the per-call limit', () => {
    const budget = { ...defaultExtractionBudget('vtt-transcript', 20_000), maxTokensPerCall: 10, maxCalls: 3 };
    const slices = planExtractionSlices([window(1, 6), window(2, 4), window(3, 7)], budget);
    expect(slices.map((slice) => slice.windows.map((item) => item.seq))).toEqual([[1, 2], [3]]);
    expect(slices.every((slice) => slice.estimatedSourceTokens <= 10)).toBe(true);
  });

  it('rejects plans that cannot fit the configured call budget', () => {
    const budget = { ...defaultExtractionBudget('text-note', 100), maxTokensPerCall: 5, maxCalls: 1 };
    expect(() => planExtractionSlices([window(1, 5), window(2, 5)], budget)).toThrow(/requires 2 calls/);
  });
});

describe('watched Inbox scanner', () => {
  it('waits for stability and enqueues once through the injected Cockpit-compatible route', async () => {
    const root = temporaryDirectory();
    const inbox = path.join(root, '00_Inbox', 'Unsorted');
    mkdirSync(inbox, { recursive: true });
    writeFileSync(path.join(inbox, 'synthetic-note.txt'), 'Action: verify the synthetic import.', 'utf8');
    let time = 0;
    const enqueued: string[] = [];
    const scanner = new WatchedInboxScanner({
      projectId: 'synthetic-project',
      inboxPath: inbox,
      stabilityMs: 100,
      minimumStableScans: 2,
      now: () => time,
      enqueue: async (_projectId, file) => {
        enqueued.push(Buffer.from(file.dataBase64, 'base64').toString('utf8'));
        return { duplicate: false, sourceId: 'synthetic-source' };
      },
    });

    expect((await scanner.scan())[0].status).toBe('observed');
    time = 200;
    expect((await scanner.scan())[0].status).toBe('enqueued');
    time = 2_000;
    expect((await scanner.scan())[0].status).toBe('duplicate');
    expect(enqueued).toEqual(['Action: verify the synthetic import.']);
  });

  it('deduplicates identical content across different paths and ignores partial files', async () => {
    const root = temporaryDirectory();
    writeFileSync(path.join(root, 'one.txt'), 'Synthetic duplicate bytes.', 'utf8');
    writeFileSync(path.join(root, 'two.txt'), 'Synthetic duplicate bytes.', 'utf8');
    writeFileSync(path.join(root, 'upload.partial'), 'Incomplete.', 'utf8');
    let time = 0;
    let calls = 0;
    const scanner = new WatchedInboxScanner({
      projectId: 'synthetic-project',
      inboxPath: root,
      stabilityMs: 0,
      minimumStableScans: 2,
      now: () => time,
      enqueue: async () => {
        calls += 1;
        return { duplicate: false };
      },
    });

    await scanner.scan();
    time = 1;
    const events = await scanner.scan();
    expect(events.filter((event) => event.status === 'enqueued')).toHaveLength(1);
    expect(events.filter((event) => event.status === 'duplicate')).toHaveLength(1);
    expect(events.filter((event) => event.status === 'ignored')).toHaveLength(1);
    expect(calls).toBe(1);
  });
});
