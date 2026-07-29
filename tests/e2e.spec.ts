import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('Today starts as the daily control view without fictional Microsoft 365 data', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Today command view' })).toBeVisible();
  await expect(page.getByText('Microsoft 365 not connected')).toBeVisible();
  await expect(page.getByText('No calendar events are available in the local projection.')).toBeVisible();
});

test('Portfolio to attention item to Project Detail still works end to end', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await page.goto('/#/projects');
  await expect(page.getByRole('heading', { name: 'Implementation focus, without the noise.' })).toBeVisible();
  await expect(page.locator('#attention').getByRole('heading', { level: 2 })).toHaveText(/^Needs /);
  await expect(page.getByRole('heading', { name: 'Project Atlas' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Project Beacon' })).toBeVisible();
  await page.getByRole('link', { name: 'Confirm the pilot cutover window', exact: true }).click();
  await expect(page).toHaveURL(/#\/projects\/atlas\?focus=action/);
  await expect(page.getByRole('heading', { name: 'Project Atlas' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Actions' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'AI write and verification status' })).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test('Inbox renders an honest unauthenticated empty projection', async ({ page }) => {
  await page.goto('/#/inbox');
  await expect(page.getByRole('heading', { name: 'Inbox control' })).toBeVisible();
  await expect(page.getByText('Microsoft 365 not connected')).toBeVisible();
  await expect(page.getByText('No Inbox messages are available in the local projection.')).toBeVisible();
});

test('project cards navigate to both fictional project routes', async ({ page }) => {
  await page.goto('/#/projects');
  await page.getByRole('heading', { name: 'Project Beacon' }).getByRole('link').click();
  await expect(page).toHaveURL(/#\/projects\/beacon$/);
  await expect(page.getByText('BCN-02 . Solution design')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Risks and issues' })).toBeVisible();
});

test('core Today view has no serious automated accessibility violations', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Today command view' })).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact ?? ''))).toEqual([]);
});

test('API exposes health and does not hard-delete mail', async ({ request }) => {
  const health = await request.get('/api/health');
  expect(health.ok()).toBe(true);
  const project = await request.get('/api/projects/atlas');
  expect(project.ok()).toBe(true);
  expect((await project.json()).project.name).toBe('Project Atlas');
  const missingConfigStart = await request.post('/api/m365/auth/start');
  expect(missingConfigStart.status()).toBe(500);
  expect(await missingConfigStart.json()).toMatchObject({ error: expect.stringContaining('Missing local Microsoft 365 config') });
});
