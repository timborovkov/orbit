'use client';

import { useState } from 'react';

import { saveFirecrawlCredential, saveWebResearchAccess } from '@/actions/research';
import { AccessCredentialForms } from '@/app/access-credential-forms';
import { SeedListEditor } from '@/app/seed-list-editor';
import { WorkspaceForm } from '@/app/workspace-form';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  type ResearchKeySource,
  WEB_CRAWL,
  WEB_READ,
  WEB_SEARCH,
  type WebTool,
} from '@/lib/research';
import type { WebResearchSeeds } from '@/lib/runtime/research/seeds';

const researchTools = [
  {
    id: WEB_SEARCH,
    label: 'Search the web',
    description: 'Find ranked sources and excerpts with Firecrawl search.',
  },
  {
    id: WEB_READ,
    label: 'Read a web page',
    description: 'Read one public page and save a citation to the run.',
  },
  {
    id: WEB_CRAWL,
    label: 'Crawl a site',
    description: 'Read multiple pages within an approved scope and track progress in Activity.',
  },
] as const;

const connectionLabels: Record<ResearchKeySource, string> = {
  agent: 'Agent key',
  environment: 'Environment default',
  keyless: 'Custom endpoint without a configured key',
  missing: 'Firecrawl API key required',
};

export function ResearchAccess({
  agentId,
  tools,
  scopes,
  seeds,
  keySource,
}: {
  agentId: string;
  tools: WebTool[];
  scopes: string[];
  seeds: WebResearchSeeds;
  keySource: ResearchKeySource;
}) {
  const [enabled, setEnabled] = useState<Record<WebTool, boolean>>(() => ({
    [WEB_SEARCH]: tools.includes(WEB_SEARCH),
    [WEB_READ]: tools.includes(WEB_READ),
    [WEB_CRAWL]: tools.includes(WEB_CRAWL),
  }));

  return (
    <div className="research-access">
      <section aria-labelledby="research-access-heading">
        <div className="editor-section-heading">
          <h2 id="research-access-heading">Web research</h2>
          <p className="muted">
            Enable the tools this agent may use, then add seed queries and preferred sources so runs
            know what to search for.
          </p>
        </div>
        <WorkspaceForm action={saveWebResearchAccess} label="Save web research access" saveState>
          <input type="hidden" name="agentId" value={agentId} />
          {(Object.keys(enabled) as WebTool[]).map((id) =>
            enabled[id] ? <input key={`tool-${id}`} type="hidden" name="tools" value={id} /> : null,
          )}
          <div className="research-tool-list">
            {researchTools.map(({ id, label, description }) => (
              <Field
                orientation="horizontal"
                key={id}
                className="research-tool-row items-center justify-between gap-4"
              >
                <div className="space-y-1">
                  <FieldLabel htmlFor={id}>{label}</FieldLabel>
                  <FieldDescription id={id + '-description'}>{description}</FieldDescription>
                </div>
                <Switch
                  id={id}
                  checked={enabled[id]}
                  aria-describedby={id + '-description'}
                  aria-label={label}
                  onCheckedChange={(value) => {
                    setEnabled((previous) => ({ ...previous, [id]: value }));
                  }}
                />
              </Field>
            ))}
          </div>

          <div className="research-seeds">
            <div className="editor-section-heading">
              <h3>Seed queries</h3>
              <p className="muted">
                Starting search phrases the agent should prefer when researching. Shown as guidance
                in tool prompts — not executed automatically.
              </p>
            </div>
            <SeedListEditor
              key={`queries-${seeds.queries.join('\u0001')}`}
              name="seedQuery"
              label="Seed query"
              initialValues={seeds.queries}
              placeholder="e.g. AI agent observability best practices"
              maxLength={500}
            />
          </div>

          <div className="research-seeds">
            <div className="editor-section-heading">
              <h3>Preferred sources</h3>
              <p className="muted">
                Sites or pages to prefer as starting points for reads and crawls.
              </p>
            </div>
            <SeedListEditor
              key={`sources-${seeds.sources.join('\u0001')}`}
              name="seedSource"
              label="Preferred source"
              initialValues={seeds.sources}
              placeholder="https://example.com/docs"
              maxLength={2048}
            />
          </div>

          <Field>
            <FieldLabel htmlFor="web-crawl-scopes">Approved crawl sites or paths</FieldLabel>
            <Textarea
              id="web-crawl-scopes"
              name="scopes"
              rows={4}
              maxLength={10_000}
              defaultValue={scopes.join('\n')}
              aria-describedby="web-crawl-help"
            />
            <FieldDescription id="web-crawl-help">
              Enter one public URL per line, or enter * on its own line to approve any public site
              for this agent.
            </FieldDescription>
          </Field>
        </WorkspaceForm>
      </section>
      <section aria-labelledby="research-credential-heading">
        <div className="editor-section-heading">
          <h2 id="research-credential-heading">Firecrawl</h2>
          <p className="muted">{connectionLabels[keySource]}</p>
        </div>
        <AccessCredentialForms
          agentId={agentId}
          hasAgentCredential={keySource === 'agent'}
          credentialAction={saveFirecrawlCredential}
          placeholder="Enter a Firecrawl key for this agent"
          credentialLabel="Firecrawl agent API key"
        />
      </section>
    </div>
  );
}
