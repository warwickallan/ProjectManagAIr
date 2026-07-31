import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

test('synthetic source intake stays useful without a reasoning provider', async ({ page, request }) => {
  const projectsRoot = path.join(process.cwd(), 'artifacts', 'source-intelligence-projects');
  mkdirSync(projectsRoot, { recursive: true });
  const settings = await request.post('/api/project-storage/settings', { data: { projectsRoot, projectFolderNamingFormat: '{code} - {name}' } });
  expect(settings.ok()).toBe(true);
  const verified = await request.post('/api/project-storage/verify', { data: { writeTest: true } });
  expect(verified.ok()).toBe(true);

  const created = await request.post('/api/projects', { data: { code: 'SYN-E2E', name: 'Synthetic Source Intelligence', customer: 'Fictional Customer', description: 'Synthetic browser acceptance project.', status: 'active', owner: 'Casey' } });
  expect(created.ok(), `${created.status()} ${await created.text()}`).toBe(true);
  const { projectId } = await created.json() as { projectId: string };
  const sourceText = ['WEBVTT', '', '00:00:01.000 --> 00:00:04.000', 'Casey: Action: confirm the synthetic release route by Friday.'].join('\n');
  const uploaded = await request.post(`/api/projects/${projectId}/sources`, { data: { files: [{ name: 'synthetic-release.vtt', type: 'text/vtt', dataBase64: Buffer.from(sourceText).toString('base64') }] } });
  expect(uploaded.ok(), `${uploaded.status()} ${await uploaded.text()}`).toBe(true);

  const detail = await request.get(`/api/projects/${projectId}`);
  expect(detail.ok()).toBe(true);
  const body = await detail.json();
  expect(body.project.sourceIntelligence.sources).toHaveLength(1);
  expect(body.project.sourceIntelligence.sources[0]).toMatchObject({ sourceType: 'vtt-transcript', segmentCount: 1, metrics: { calls: 0, inputTokens: 0, outputTokens: 0 } });
  expect(body.project.sourceIntelligence.sources[0].windows.length).toBeGreaterThan(0);
  expect(body.project.consultantBrief.generationMode).toBe('deterministic-template');

  const pinned = await request.post(`/api/projects/${projectId}/overview/pin`, { data: { mode: 'meeting' } });
  expect(pinned.ok()).toBe(true);
  expect((await pinned.json()).pinnedMode).toBe('meeting');

  await page.goto(`/#/projects/${projectId}/inbox`);
  await expect(page.getByRole('heading', { name: 'Synthetic Source Intelligence' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Project Inbox' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Governed review lanes' })).toBeVisible();
  await expect(page.getByText('synthetic-release.vtt')).toBeVisible();
  await expect(page.locator('.source-metrics')).toContainText('Model calls');
});