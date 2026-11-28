import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';
import postgres from 'postgres';

import { budgetDefaults } from '@/lib/budgets';

import { openAccessSection, openWorkspaceTab } from './workspace-nav';

const sql = postgres('postgres://orbit:orbit_dev@localhost:5432/orbit_test');
const agentId = randomUUID();
const configId = randomUUID();
const runId = randomUUID();
const intentId = randomUUID();
const crawlId = randomUUID();
const citationId = randomUUID();
const libraryId = randomUUID();
const actor = 'web-research-playwright@example.com';
const target = 'https://docs.firecrawl.dev/api-reference/endpoint';
const excerpt = 'Public documentation about provider pagination.';

test.afterAll(async () => {
  await sql`DELETE FROM knowledge_chunks WHERE document_id IN (SELECT id FROM knowledge_documents WHERE library_id = ${libraryId})`;
  await sql`DELETE FROM knowledge_documents WHERE library_id = ${libraryId}`;
  await sql`DELETE FROM knowledge_libraries WHERE id = ${libraryId}`;
  await sql`DELETE FROM action_intents WHERE id = ${intentId}`;
  await sql`DELETE FROM simulation_runs WHERE agent_id = ${agentId}`;
  await sql`DELETE FROM agent_configurations WHERE id = ${configId}`;
  await sql`DELETE FROM agents WHERE id = ${agentId}`;
  await sql.end();
});

test('edits independent grants, cancels a pending crawl and imports a cited page', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await sql`INSERT INTO agents (id, name, mission, budgets)
    VALUES (${agentId}, 'Research operator', 'Find public evidence.', ${sql.json(budgetDefaults)})`;
  await sql`INSERT INTO agent_configurations (id, agent_id, version, config, actor)
    SELECT ${configId}, ${agentId}, 1, config, ${actor} FROM templates WHERE id = 'support'`;
  await sql`INSERT INTO simulation_runs (id, agent_id, configuration_id, status, input, result, actor, expires_at, finished_at, created_at)
    VALUES (${runId}, ${agentId}, ${configId}, 'completed', 'Inspect crawl documentation',
      ${sql.json({ steps: [], actions: [] })}, ${actor}, now(), now(), now() - interval '1 hour')`;
  await sql`INSERT INTO simulation_runs (agent_id, configuration_id, status, input, result, actor, expires_at, finished_at)
    SELECT ${agentId}, ${configId}, 'completed', 'Newer run ' || index, ${sql.json({ steps: [], actions: [] })}, ${actor}, now(), now()
    FROM generate_series(1, 51) AS index`;
  await sql`INSERT INTO action_intents (id, agent_id, run_id, action_type, idempotency_key, decision)
    VALUES (${intentId}, ${agentId}, ${runId}, 'web.crawl', ${intentId}, 'allow')`;
  await sql`INSERT INTO web_crawls (id, agent_id, run_id, intent_id, seed_url, origin_hash, page_limit, depth_limit, deadline)
    VALUES (${crawlId}, ${agentId}, ${runId}, ${intentId}, ${target}, 'fixture', 10, 1, now() + interval '10 minutes')`;
  await sql`INSERT INTO web_citations (id, agent_id, run_id, intent_id, crawl_id, tool, rank, url, title, excerpt, content)
    VALUES (${citationId}, ${agentId}, ${runId}, ${intentId}, ${crawlId}, 'web.crawl', 1, ${target + '/crawl-get'},
      'Crawl status reference', ${excerpt}, ${excerpt})`;
  await sql`INSERT INTO knowledge_libraries (id, name) VALUES (${libraryId}, 'Web research test library')`;

  await page.goto('/login');
  await page.getByLabel(/^Email/).fill('admin@example.com');
  await page.getByLabel(/^Password/).fill('test-only-password-123456');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto('/agents/' + agentId);
  await openWorkspaceTab(page, 'Access');
  await openAccessSection(page, 'Web research');
  for (const name of ['Search the web', 'Read a web page', 'Crawl a site']) {
    const grant = page.getByRole('switch', { name });
    await expect(grant).not.toBeChecked();
    await grant.click();
  }
  await page.getByLabel('Approved crawl sites or paths').fill(target);
  await page.getByRole('button', { name: 'Save web research access' }).click();
  await expect(page.getByText('Web research access saved.')).toBeVisible();
  const [agent] = await sql`SELECT enabled_tools FROM agents WHERE id = ${agentId}`;
  expect(agent.enabled_tools).toEqual(['web.search', 'web.read', 'web.crawl']);

  const fixtureKey = 'playwright-firecrawl-agent-override';
  await page.getByLabel('Firecrawl agent API key', { exact: true }).fill(fixtureKey);
  await page.getByRole('button', { name: 'Save agent key', exact: true }).click();
  await expect(page.getByText('Agent key saved.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Firecrawl agent API key', { exact: true })).toHaveValue('');
  await expect(page.locator('body')).not.toContainText(fixtureKey);
  await page.getByRole('button', { name: 'Remove agent key', exact: true }).click();
  await expect(page.getByText('Agent key removed.', { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 900 });
  await openAccessSection(page, 'Web research');
  await expect(page.getByLabel('Approved crawl sites or paths')).toHaveValue(target);
  await openWorkspaceTab(page, 'History');
  const runSummary = page.locator('#run-' + runId + ' > summary');
  const nextPage = page.getByRole('navigation', { name: 'Run pages' }).getByRole('button', {
    name: 'Next',
  });
  while ((await runSummary.count()) === 0 && (await nextPage.isEnabled())) {
    await nextPage.click();
  }
  await expect(runSummary).toBeVisible();
  await runSummary.click();
  const crawl = page.getByRole('region', { name: 'Crawl ' + target });
  await expect(crawl).toContainText('Queued');
  await expect(crawl).toContainText('depth limit 1');
  const citation = crawl.getByRole('link', { name: 'Crawl status reference' });
  await expect(citation).toHaveAttribute('href', target + '/crawl-get');
  await expect(citation).toHaveAttribute('target', '_blank');
  const crawlTarget = crawl.getByRole('link', {
    name: target + ' (opens in a new tab)',
    exact: true,
  });
  await expect(crawlTarget).toHaveAttribute('href', target);
  await expect(crawlTarget).toHaveAttribute('target', '_blank');
  await expect(crawl.getByText(excerpt)).toBeVisible();
  await crawl.getByRole('button', { name: 'Cancel crawl' }).click();
  await expect(crawl.getByText(/Cancelled ·/)).toBeVisible();

  const before =
    await sql`SELECT id FROM knowledge_documents WHERE web_citation_id = ${citationId}`;
  expect(before).toHaveLength(0);
  await crawl.getByText('Import page', { exact: true }).click();
  await crawl.getByRole('combobox', { name: 'Shared library' }).click();
  await page.getByRole('option', { name: 'Web research test library' }).click();
  await crawl.getByRole('button', { name: 'Import into shared library' }).click();
  await expect(crawl.getByText('Document uploaded and queued for processing.')).toBeVisible();
  const after = await sql`SELECT id FROM knowledge_documents WHERE web_citation_id = ${citationId}`;
  expect(after).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});
