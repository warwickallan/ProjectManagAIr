import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * Browser acceptance for Settings → AI Skills & Prompts and the consultant
 * views, with no reasoning provider available.
 *
 * This is the provider-free test: the E2E server has no Claude CLI, so every
 * assertion here is about what the Cockpit does when the model is absent. The
 * deterministic views must be complete and must never be labelled as generated.
 */

test('prompts are manageable and consultant views are complete without a provider', async ({ page, request }) => {
  const projectsRoot = path.join(process.cwd(), 'artifacts', 'prompt-management-projects');
  mkdirSync(projectsRoot, { recursive: true });
  expect((await request.post('/api/project-storage/settings', { data: { projectsRoot, projectFolderNamingFormat: '{code} - {name}' } })).ok()).toBe(true);
  expect((await request.post('/api/project-storage/verify', { data: { writeTest: true } })).ok()).toBe(true);

  /* ---------------------------------------------------------------- registry */

  const catalogueResponse = await request.get('/api/extraction-skills');
  expect(catalogueResponse.ok()).toBe(true);
  const { catalogue } = await catalogueResponse.json() as { catalogue: Array<{ skillId: string; name: string; activeVersion: string | null; versions: Array<{ version: string; status: string }> }> };
  const ids = catalogue.map((entry) => entry.skillId).sort();
  expect(ids).toEqual(['completeness-challenge', 'consultant-brief', 'global-reconciliation', 'source-comprehension', 'source-extraction']);
  expect(catalogue.find((entry) => entry.skillId === 'source-extraction')!.activeVersion).toBe('2.0.0');

  // The published revision is readable and downloadable as Markdown.
  const body = await request.get('/api/extraction-skills/source-extraction/versions/2.0.0');
  expect(body.ok()).toBe(true);
  const revision = await body.json() as { text: string; editable: boolean; containsCustomerSource: boolean };
  expect(revision.text.length).toBeGreaterThan(200);
  expect(revision.editable).toBe(false);
  expect(revision.containsCustomerSource).toBe(false);

  const download = await request.get('/api/extraction-skills/source-extraction/versions/2.0.0/download');
  expect(download.ok()).toBe(true);
  expect(download.headers()['content-type']).toContain('text/markdown');
  expect(await download.text()).toBe(revision.text);

  // An upload creates a draft and does not move the published pointer.
  const draft = [
    '---',
    'skillId: source-extraction',
    'name: Project Source Extraction',
    'version: 2.9.0',
    'promptTemplateVersion: source-extraction-prompt-v2',
    'status: draft',
    'purpose: Browser acceptance draft.',
    'notes: Uploaded by the end-to-end acceptance test.',
    '---',
    'Return one JSON object with rows, windowCoverage and categoryCoverage.',
    'Every element of rows carries a client_ref and anchors.',
  ].join('\n');
  const validation = await request.post('/api/extraction-skills/validate', { data: { text: draft, expectedSkillId: 'source-extraction' } });
  expect(validation.ok()).toBe(true);
  expect((await validation.json()).ok).toBe(true);

  const uploaded = await request.post('/api/extraction-skills/drafts', { data: { text: draft, expectedSkillId: 'source-extraction', actor: 'e2e' } });
  expect(uploaded.ok(), `${uploaded.status()} ${await uploaded.text()}`).toBe(true);
  expect((await uploaded.json()).status).toBe('draft');

  const afterUpload = await (await request.get('/api/extraction-skills')).json() as { catalogue: Array<{ skillId: string; activeVersion: string | null; versions: Array<{ version: string; status: string }> }> };
  const extraction = afterUpload.catalogue.find((entry) => entry.skillId === 'source-extraction')!;
  expect(extraction.activeVersion).toBe('2.0.0');
  expect(extraction.versions.find((version) => version.version === '2.9.0')!.status).toBe('draft');

  // A second upload of the same version is refused rather than overwriting it.
  const duplicate = await request.post('/api/extraction-skills/drafts', { data: { text: draft, actor: 'e2e' } });
  expect(duplicate.ok()).toBe(false);

  // Comparison works between the published version and the draft.
  const comparison = await request.get('/api/extraction-skills/compare?skillId=source-extraction&from=2.0.0&to=2.9.0');
  expect(comparison.ok()).toBe(true);
  const diff = await comparison.json() as { identical: boolean; addedLines: number; removedLines: number };
  expect(diff.identical).toBe(false);
  expect(diff.addedLines + diff.removedLines).toBeGreaterThan(0);

  /* ------------------------------------------------------- consultant views */

  const created = await request.post('/api/projects', { data: { code: 'PRM-E2E', name: 'Prompt Management Acceptance', customer: 'Fictional Customer', description: 'Browser acceptance project.', status: 'active', owner: 'Casey' } });
  expect(created.ok(), `${created.status()} ${await created.text()}`).toBe(true);
  const { projectId } = await created.json() as { projectId: string };

  // The project payload carries both deterministic views and reports zero calls.
  const detail = await (await request.get(`/api/projects/${projectId}`)).json();
  expect(detail.project.consultantViews).toHaveLength(2);
  for (const view of detail.project.consultantViews) {
    expect(view.providerCalls).toBe(0);
    expect(view.sections.length).toBeGreaterThan(0);
  }

  for (const mode of ['meeting', 'needs-warwick']) {
    const view = await request.get(`/api/projects/${projectId}/consultant-view?mode=${mode}`);
    expect(view.ok()).toBe(true);
    const payload = await view.json() as { providerCallsThisRequest: number; synthesisState: string; deterministic: { providerCalls: number } };
    expect(payload.providerCallsThisRequest).toBe(0);
    expect(payload.deterministic.providerCalls).toBe(0);
    expect(payload.synthesisState).toBe('none');
  }

  // With no provider on this host, Generate fails readably and generates nothing.
  const generated = await request.post(`/api/projects/${projectId}/consultant-view`, { data: { mode: 'needs-warwick' } });
  expect(generated.ok()).toBe(true);
  const generation = await generated.json() as { synthesisState: string; synthesis: unknown; failure: { message: string; recoveryAction: string } | null; deterministic: { providerCalls: number } };
  expect(generation.synthesisState).toBe('failed');
  expect(generation.synthesis).toBeNull();
  expect(generation.failure).not.toBeNull();
  expect(generation.failure!.recoveryAction.length).toBeGreaterThan(10);
  // The deterministic view is untouched and is not presented as generated.
  expect(generation.deterministic.providerCalls).toBe(0);

  // The download says plainly that nothing was generated.
  const markdown = await request.get(`/api/projects/${projectId}/consultant-view/download?mode=needs-warwick`);
  expect(markdown.ok()).toBe(true);
  expect(await markdown.text()).toContain('Generated reasoning: none');

  /* -------------------------------------------------------------------- UI */

  await page.goto('/#/settings');
  await expect(page.getByRole('heading', { name: 'AI Skills & Prompts' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Project Source Extraction/ })).toBeVisible();
  await expect(page.getByText('Fixed application safety')).toBeVisible();
  await expect(page.getByText('Deterministic replay from the frozen packet')).toBeVisible();

  /* -------------------------------------------------------- build handoffs */

  // Reading build handoffs is a filesystem read: it must answer on a machine
  // with no handoffs, no bundle and no GitHub credential, and it must not push.
  const handoffs = await request.get('/api/build-handoffs');
  expect(handoffs.ok()).toBe(true);
  const handoffBody = await handoffs.json() as { root: string; pending: string; completed: string; handoffs: unknown[] };
  expect(handoffBody.pending.endsWith('pending')).toBe(true);
  expect(Array.isArray(handoffBody.handoffs)).toBe(true);

  // A manifest path this machine does not offer is refused before anything runs.
  const refused = await request.post('/api/build-handoffs/finalize', { data: { manifestPath: '/tmp/not-a-handoff.json' } });
  expect(refused.status()).toBe(400);
  expect((await refused.json()).error).toMatch(/not one of this machine/i);

  await page.goto('/#/settings');
  await expect(page.getByRole('heading', { name: 'Build Handoffs' })).toBeVisible();
  await expect(page.getByText(/never merges, never force-pushes/i)).toBeVisible();
  // GitHub is the canonical record, so the panel says so rather than presenting
  // the Google Drive mirror as part of finishing a build.
  await expect(page.getByText(/sanitised build record is committed/i)).toBeVisible();

  await page.goto(`/#/projects/${projectId}/overview`);
  await expect(page.getByRole('heading', { name: 'Meeting Brief' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Consultant reasoning' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Generate consultant view/ })).toBeVisible();
  await expect(page.getByText('One press, at most one bounded model call.')).toBeVisible();
});
