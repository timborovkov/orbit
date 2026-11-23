import { expect, type Page, test } from '@playwright/test';
import postgres from 'postgres';

import { openWorkspaceTab } from './workspace-nav';

const handbook = 'The handbook travel policy requires advance approval.';

async function inspectHandbook(page: Page, agentId: string) {
  await page.goto(`/agents/${agentId}`);
  await openWorkspaceTab(page, 'Knowledge');
  const sections = page.getByLabel('Knowledge section', { exact: true });
  const button = page.getByRole('button', { name: 'Inspector', exact: true });
  if (await page.evaluate(() => matchMedia('(max-width: 900px)').matches)) {
    await sections.click();
    await page.getByRole('option', { name: 'Inspector', exact: true }).click();
  } else {
    await button.click();
  }
  await page.getByRole('textbox', { name: 'Query' }).fill('handbook travel policy');
  await page.getByRole('button', { name: 'Inspect', exact: true }).click();
  return page.getByRole('region', { name: 'Inspector' });
}

test('admins share one indexed handbook and source access follows current grants', async ({
  page,
  request,
}) => {
  test.setTimeout(90000);
  const sql = postgres('postgres://orbit:orbit_dev@localhost:5432/orbit_test');
  try {
    await sql`TRUNCATE web_citations, web_crawls, agent_firecrawl_credentials, agent_memory_evidence_revisions, agent_memories, person_relationship_notes, person_identity_changes, person_link_rejections, person_contacts, person_identities, people, evaluation_comparisons, evaluation_cases, agent_activity_events, follow_ups, outbound_actions, source_events, discovery_cursors, email_messages, email_threads, email_mailboxes, knowledge_chunks, knowledge_documents, knowledge_library_grants, knowledge_libraries, recipient_consents, introduction_proposals, policy_decisions, action_intents, usage_counters, simulation_runs, jobs, agent_credentials, agent_configurations, agent_skills, agent_mcp_connections, skills, mcp_connections, sessions, agents, audit, login_attempts`;
    const agentIds: Record<string, string> = {};
    for (const name of ['Sarah', 'John', 'Maya']) {
      const [agent] = await sql`
        INSERT INTO agents(name,mission) VALUES (${name},'Answer handbook questions') RETURNING id
      `;
      await sql`
        INSERT INTO agent_configurations(agent_id,version,config,actor)
        SELECT ${agent.id},1,config || jsonb_build_object('name', ${name}::text),'test'
        FROM templates WHERE id='support'
      `;
      agentIds[name] = agent.id;
    }
    await page.setViewportSize({ width: 1440, height: 950 });
    await page.goto('/login');
    await page.getByLabel(/^Email/).fill('admin@example.com');
    await page.getByLabel(/^Password/).fill('test-only-password-123456');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page
      .getByRole('navigation', { name: 'Workspace', exact: true })
      .getByRole('link', { name: 'Knowledge' })
      .click();
    await expect(page.getByRole('heading', { name: 'No shared libraries yet' })).toBeVisible();

    const trigger = page.getByRole('button', { name: 'New library' });
    await trigger.click();
    const name = page.getByRole('textbox', { name: 'Name', exact: true });
    await expect(name).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    await trigger.click();
    await name.fill('Travel handbook');
    await page.getByRole('button', { name: 'Create library' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await page.getByRole('link', { name: 'Travel handbook', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Travel handbook', exact: true })).toBeVisible();
    const libraryUrl = page.url();

    const documents = page.getByRole('region', { name: 'Documents', exact: true });
    await documents
      .locator('input[type=file]')
      .first()
      .setInputFiles({
        name: 'handbook.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from(handbook),
      });
    const documentRow = documents.getByRole('listitem').filter({ hasText: 'handbook' });
    await expect(documentRow.getByText('Ready', { exact: true })).toBeVisible({ timeout: 20000 });

    for (const name of ['Sarah', 'John']) {
      await page.getByRole('button', { name: `Grant access for ${name}` }).click();
      await expect(page.getByRole('button', { name: `Revoke access for ${name}` })).toBeEnabled();
    }

    await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link').click();
    const libraryRow = page.getByRole('row', { name: 'Travel handbook 1 2', exact: true });
    await expect(libraryRow).toBeVisible();

    const sharedRows = await sql`
      SELECT document.id, document.object_key,
        (SELECT count(*)::int FROM knowledge_chunks WHERE document_id=document.id) AS chunks,
        (SELECT count(*)::int FROM jobs WHERE type='knowledge.process.shared'
          AND payload->>'documentId'=document.id::text) AS jobs
      FROM knowledge_documents AS document
      WHERE library_id IS NOT NULL
    `;
    expect(sharedRows).toHaveLength(1);
    expect(sharedRows[0]).toMatchObject({ chunks: 1, jobs: 1 });
    expect(sharedRows[0].object_key).toMatch(/^knowledge-libraries\//);
    const sourcePath = (agentId: string) =>
      `/agents/${agentId}/knowledge/sources/${sharedRows[0].id}`;

    await page.goto(`/agents/${agentIds.Sarah}`);
    await openWorkspaceTab(page, 'Knowledge');
    const sharedLibraries = page.getByRole('region', { name: 'Shared libraries' });
    await expect(sharedLibraries.getByRole('link', { name: 'Travel handbook' })).toBeVisible();
    await expect(sharedLibraries.getByText('1 of 1 ready')).toBeVisible();
    await expect(sharedLibraries.getByText(/Enable knowledge search/)).toBeVisible();

    for (const name of ['Sarah', 'John']) {
      const inspector = await inspectHandbook(page, agentIds[name]);
      await expect(inspector.getByText(handbook, { exact: true })).toBeVisible();
      await inspector.getByRole('button', { name: 'Details' }).click();
      const citation = inspector.getByRole('link', { name: 'handbook.txt' });
      await expect(citation).toHaveAttribute('href', sourcePath(agentIds[name]));
      const source = await page.request.get(sourcePath(agentIds[name]));
      expect(source.status()).toBe(200);
      expect(source.headers()['cache-control']).toContain('no-store');
      expect(source.headers()['content-disposition']).toContain('attachment');
      expect(await source.text()).toBe(handbook);
    }
    expect((await request.get(sourcePath(agentIds.Sarah))).status()).toBe(404);

    const maya = await inspectHandbook(page, agentIds.Maya);
    await expect(maya.getByText('No matching passages', { exact: true })).toBeVisible();
    expect((await page.request.get(sourcePath(agentIds.Maya))).status()).toBe(404);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(libraryUrl);
    await page.getByRole('button', { name: 'Revoke access for John' }).click();
    await expect(page.getByRole('button', { name: 'Grant access for John' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Revoke access for Sarah' })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link').click();
    await expect(page.getByText('1 document · 1 agent with access')).toBeVisible();

    const john = await inspectHandbook(page, agentIds.John);
    await expect(john.getByText('No matching passages', { exact: true })).toBeVisible();
    expect((await page.request.get(sourcePath(agentIds.John))).status()).toBe(404);
    const sarah = await inspectHandbook(page, agentIds.Sarah);
    await expect(sarah.getByText(handbook, { exact: true })).toBeVisible();
    expect((await page.request.get(sourcePath(agentIds.Sarah))).status()).toBe(200);

    await page.goto(libraryUrl);
    const actions = page.getByRole('button', { name: 'Actions for handbook' });
    await actions.click();
    await page.getByRole('menuitem', { name: 'Reprocess' }).click();
    const completedSharedJobs = async () => {
      const [row] = await sql`
        SELECT count(*)::int AS total FROM jobs
        WHERE type='knowledge.process.shared' AND status='completed'
          AND payload->>'documentId'=${sharedRows[0].id}
      `;
      return row.total;
    };
    await expect.poll(completedSharedJobs).toBe(2);

    await actions.click();
    const fileChooser = page.waitForEvent('filechooser');
    await page.getByRole('menuitem', { name: 'Replace…' }).click();
    const revisedHandbook = 'The updated handbook travel policy requires manager approval.';
    await (
      await fileChooser
    ).setFiles({
      name: 'handbook.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(revisedHandbook),
    });
    await expect.poll(completedSharedJobs).toBe(3);
    const revised = await page.request.get(sourcePath(agentIds.Sarah));
    expect(await revised.text()).toBe(revisedHandbook);

    await actions.click();
    await page.getByRole('menuitem', { name: 'Delete…' }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Delete', exact: true })
      .click();
    await expect(documents.getByRole('heading', { name: 'No documents yet' })).toBeVisible();
    expect((await page.request.get(sourcePath(agentIds.Sarah))).status()).toBe(404);
  } finally {
    await sql.end();
  }
});
