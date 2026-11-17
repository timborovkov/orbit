import { notFound } from 'next/navigation';
import { and, desc, eq } from 'drizzle-orm';
import { ChevronDown, FlaskConical, History, KeyRound, ShieldCheck } from 'lucide-react';
import { z } from 'zod';

import { runSimulation, saveConfiguration, saveCredential } from '@/actions/workspace';
import { AgentAvatar } from '@/app/agent-avatar';
import { ConfigFields } from '@/app/config-fields';
import { ProfilePictureEditor } from '@/app/profile-picture-editor';
import { RunContent } from '@/app/run-content';
import { WorkspaceField, WorkspaceSelect } from '@/app/workspace-field';
import { WorkspaceForm } from '@/app/workspace-form';
import { WorkspaceHeader } from '@/app/workspace-header';
import { WorkspaceTabs } from '@/app/workspace-tabs';
import { requireAdmin } from '@/lib/auth';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { agents, configurations, credentials, runs } from '@/lib/schema';
import { storageConfigured } from '@/lib/storage/objects';

export const dynamic = 'force-dynamic';
export default async function AgentWorkspace({ params }: { params: Promise<{ id: string }> }) {
  const email = await requireAdmin();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const agent = (await db().select().from(agents).where(eq(agents.id, id))).at(0);
  if (!agent) notFound();
  const [versions, keys, history] = await Promise.all([
    db()
      .select()
      .from(configurations)
      .where(eq(configurations.agentId, id))
      .orderBy(desc(configurations.version)),
    db()
      .select({ agentId: credentials.agentId })
      .from(credentials)
      .where(eq(credentials.agentId, id)),
    db()
      .select()
      .from(runs)
      .where(and(eq(runs.agentId, id)))
      .orderBy(desc(runs.createdAt))
      .limit(50),
  ]);
  const current = versions.at(0);
  if (!current) notFound();
  const viewedHistory = history.map((run) => ({
    ...run,
    interrupted: run.status === 'running' && run.expiresAt < new Date(),
  }));
  const latest = viewedHistory.at(0);
  const versionFor = (configurationId: string) =>
    versions.find((version) => version.id === configurationId)?.version;
  const configuration = (
    <section id="configuration" className="configuration-workbench">
      <WorkspaceForm
        key={current.id}
        action={saveConfiguration}
        label="Save configuration"
        saveState
      >
        <input type="hidden" name="agentId" value={id} />
        <input type="hidden" name="version" value={current.version} />
        <ConfigFields
          config={current.config}
          prefix="agent"
          identityContent={
            <ProfilePictureEditor
              id={id}
              name={agent.name}
              pictureKey={agent.pictureKey}
              configured={storageConfigured()}
            />
          }
        />
      </WorkspaceForm>
    </section>
  );
  const access = (
    <section id="credential" className="access-workbench">
      <div className="editor-section-heading">
        <h2>OpenRouter connection</h2>
        <p className="muted">
          A private API key for {agent.name}. Encrypted at rest and never included in prompts.
        </p>
      </div>
      <div className="connection-status">
        <KeyRound size={20} aria-hidden="true" />
        <div>
          <h3>{keys.length ? 'Credential saved' : 'Connect OpenRouter'}</h3>
          <p className="muted" role="status">
            {keys.length
              ? 'A credential is saved. Enter a new key to replace it.'
              : 'No credential saved. Add a key to run simulations.'}
          </p>
        </div>
        <span className="state-label">{keys.length ? 'Configured' : 'Not connected'}</span>
      </div>
      <WorkspaceForm action={saveCredential} label="Save credential">
        <input type="hidden" name="agentId" value={id} />
        <label htmlFor="credential-key">API key</label>
        <input
          id="credential-key"
          type="password"
          name="credential"
          autoComplete="new-password"
          required
          maxLength={512}
          placeholder="Enter your OpenRouter key"
        />
      </WorkspaceForm>
      {keys.length > 0 && (
        <WorkspaceForm action={saveCredential} label="Remove credential">
          <input type="hidden" name="agentId" value={id} />
          <input type="hidden" name="revoke" value="true" />
        </WorkspaceForm>
      )}
    </section>
  );
  const playground = (
    <div className="playground-grid">
      <section id="simulation" className="simulation-composer">
        <div className="editor-section-heading">
          <h2>Test a conversation</h2>
          <p className="muted">See how {agent.name} would respond to a post or question.</p>
        </div>
        <WorkspaceForm action={runSimulation} label="Run simulation">
          <input type="hidden" name="agentId" value={id} />
          <WorkspaceSelect
            key={current.id}
            id="run-version"
            name="configurationId"
            label="Configuration version"
            initialValue={current.id}
            options={versions.map((version) => ({
              value: version.id,
              label: `Version ${version.version} · ${version.config.name}`,
            }))}
          />
          <WorkspaceField
            id="run-input"
            name="input"
            label="Post or question"
            required
            multiline
            maxLength={16000}
            rows={9}
          />
        </WorkspaceForm>
        <p className="simulation-note">
          <ShieldCheck size={15} aria-hidden="true" />
          <span>
            Paid model inference. Nothing is posted or sent. Save your configuration before testing.
          </span>
        </p>
      </section>
      <section className="simulation-result" aria-labelledby="latest-result-title">
        <div className="result-heading">
          <h2 id="latest-result-title">Latest result</h2>
          {latest && (
            <span className="state-label">
              v{versionFor(latest.configurationId)} ·{' '}
              {latest.interrupted ? 'interrupted' : latest.status}
            </span>
          )}
        </div>
        {latest ? (
          <RunContent run={latest} interrupted={latest.interrupted} />
        ) : (
          <div className="simulation-empty">
            <FlaskConical size={30} strokeWidth={1.25} aria-hidden="true" />
            <h3>A safe place to try things</h3>
            <p>
              Paste an input and run a simulation. Evaluation, proposed actions and drafts will
              appear here.
            </p>
          </div>
        )}
      </section>
    </div>
  );
  const historyPanel = (
    <div className="history-workbench">
      <section id="history">
        <div className="editor-section-heading">
          <h2>Run history</h2>
          <p className="muted">
            Your latest 50 simulations, with the exact configuration each one used.
          </p>
        </div>
        {!history.length && (
          <div className="history-empty">
            <History size={24} aria-hidden="true" />
            <p>No runs yet. Start in the Playground to test your agent.</p>
          </div>
        )}
        {viewedHistory.map((run) => (
          <details key={run.id} className="run-detail">
            <summary>
              <div>
                <span className="run-title">{run.input}</span>
                <time dateTime={run.createdAt.toISOString()}>
                  {run.createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC · Version{' '}
                  {versionFor(run.configurationId)}
                </time>
              </div>
              <span className="state-label">{run.interrupted ? 'interrupted' : run.status}</span>
              <ChevronDown size={14} className="disclosure-chevron" aria-hidden="true" />
            </summary>
            <RunContent run={run} interrupted={run.interrupted} />
          </details>
        ))}
      </section>
      <section className="version-history">
        <h2>Configuration versions</h2>
        <p className="muted">Every save is a snapshot. Previous runs stay unchanged.</p>
        {versions.map((version) => (
          <details key={version.id}>
            <summary>
              <span>Version {version.version}</span>
              <time>{version.createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC</time>
            </summary>
            <dl className="config-snapshot">
              {Object.entries(version.config).map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{value || '—'}</dd>
                </div>
              ))}
            </dl>
          </details>
        ))}
      </section>
    </div>
  );
  return (
    <div className="agent-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <WorkspaceHeader name={agent.name} />
      <main className="agent-main" id="main">
        {env().AUTH_DISABLED && (
          <p className="local-auth-notice">Authentication disabled · Local development · {email}</p>
        )}
        <div className="agent-title-row">
          <div className="agent-title-identity">
            <AgentAvatar
              id={id}
              name={agent.name}
              pictureKey={agent.pictureKey}
              className="agent-monogram"
            />
            <div>
              <div className="agent-name-line">
                <h1>{agent.name}</h1>
                <span className="state-label">
                  <span className="status-dot" />
                  Paused
                </span>
              </div>
              <p className="muted">{current.config.role || 'Custom agent'}</p>
            </div>
          </div>
          <div className="agent-version">
            <span>Configuration v{current.version}</span>
            <span className="muted">
              {keys.length ? 'OpenRouter configured' : 'OpenRouter not connected'}
            </span>
          </div>
        </div>
        <WorkspaceTabs
          items={[
            { id: 'configure', label: 'Configuration', content: configuration },
            { id: 'playground', label: 'Playground', content: playground },
            { id: 'history', label: 'History', count: history.length, content: historyPanel },
            { id: 'access', label: 'Access', content: access },
          ]}
        />
      </main>
    </div>
  );
}
