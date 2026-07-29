import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('Portfolio to attention item to Project Detail works end to end', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await page.goto('/');
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

test('project cards navigate to both fictional project routes', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('heading', { name: 'Project Beacon' }).getByRole('link').click();
  await expect(page).toHaveURL(/#\/projects\/beacon$/);
  await expect(page.getByText('BCN-02 · Solution design')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Risks and issues' })).toBeVisible();
});

test('core portfolio has no serious automated accessibility violations', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#attention').getByRole('heading', { level: 2 })).toHaveText(/^Needs /);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact ?? ''))).toEqual([]);
});

test('API is GET-only and returns validated project data', async ({ request }) => {
  const project = await request.get('/api/projects/atlas');
  expect(project.ok()).toBe(true);
  expect((await project.json()).project.name).toBe('Project Atlas');
  const mutation = await request.post('/api/projects/atlas', { data: { title: 'Must not write' } });
  expect(mutation.status()).toBe(405);
  expect(await mutation.json()).toMatchObject({ error: expect.stringContaining('Read-only') });
});
