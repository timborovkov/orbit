import { saveFirecrawlCredential, saveWebResearchAccess } from '@/actions/research';
import { AccessCredentialForms } from '@/app/access-credential-forms';
import { WorkspaceForm } from '@/app/workspace-form';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import {
  type ResearchKeySource,
  WEB_CRAWL,
  WEB_READ,
  WEB_SEARCH,
  type WebTool,
} from '@/lib/research';

const researchTools = [
  { id: WEB_SEARCH, label: 'Search the web', description: 'Find ranked sources and excerpts.' },
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
  keySource,
}: {
  agentId: string;
  tools: WebTool[];
  scopes: string[];
  keySource: ResearchKeySource;
}) {
  return (
    <div className="research-access">
      <section aria-labelledby="research-access-heading">
        <div className="editor-section-heading">
          <h2 id="research-access-heading">Web research</h2>
        </div>
        <WorkspaceForm action={saveWebResearchAccess} label="Save web research access" saveState>
          <input type="hidden" name="agentId" value={agentId} />
          {researchTools.map(({ id, label, description }) => (
            <Field orientation="horizontal" key={id}>
              <Checkbox
                id={id}
                name="tools"
                value={id}
                defaultChecked={tools.includes(id)}
                aria-describedby={id + '-description'}
              />
              <div>
                <FieldLabel htmlFor={id}>{label}</FieldLabel>
                <FieldDescription id={id + '-description'}>{description}</FieldDescription>
              </div>
            </Field>
          ))}
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
