import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openProjectManagairDatabase } from '../src/db';
import { createProject, intakeProjectSource, updateStorageSettings } from '../src/projectLifecycle';
import { skipSourceAfterComprehension } from '../src/sourcePipeline';

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

describe('deterministic comprehension skip', () => {
  it('creates a reviewable source-only packet without a reasoning provider call', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'projectmanagair-skip-'));
    temporaryDirectories.push(directory);
    const projectsRoot = path.join(directory, 'Projects');
    mkdirSync(projectsRoot, { recursive: true });
    const context = openProjectManagairDatabase(path.join(directory, 'skip.db'));
    try {
      await updateStorageSettings(context.db, { projectsRoot });
      const project = createProject(context.db, {
        code: 'SKIP',
        name: 'Synthetic Skip',
        customer: 'Synthetic Customer',
        description: 'Synthetic comprehension skip fixture.',
        status: 'on-track',
        owner: 'Tester',
      });
      const intake = await intakeProjectSource(context.db, project.projectId, {
        name: 'general-note.txt',
        dataBase64: Buffer.from('General synthetic conversation with no governance content.', 'utf8').toString('base64'),
      }) as unknown as { sourceId: string };

      const result = await skipSourceAfterComprehension(context.db, {
        sourceId: intake.sourceId,
        reason: 'Human comprehension review found no project-governance content.',
      });

      expect(result.calls).toBe(0);
      expect(result.provider.providerId).toBe('deterministic-comprehension-skip');
      expect(result.gateVerdict).toBe('clean');
      const run = context.db.prepare('SELECT provider_id, stage, input_tokens FROM extraction_runs WHERE id = ?').get(result.runs[0]) as Record<string, unknown>;
      expect(run).toMatchObject({ provider_id: 'deterministic-comprehension-skip', stage: 'comprehension-skip', input_tokens: 0 });
    } finally {
      context.db.close();
    }
  });
});
