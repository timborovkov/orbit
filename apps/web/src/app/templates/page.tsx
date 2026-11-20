import { ChevronDown, Layers } from 'lucide-react';

import { saveTemplate } from '@/actions/workspace';
import { ConfigFields } from '@/app/config-fields';
import { WorkspaceForm } from '@/app/workspace-form';
import { WorkspaceHeader } from '@/app/workspace-header';
import { env } from '@/lib/env';
import { getPendingApprovalCount, getTemplates } from '@/lib/server/workspace-queries';

export const dynamic = 'force-dynamic';
export default async function Templates() {
  const [{ email, items }, pendingApprovalCount] = await Promise.all([
    getTemplates(),
    getPendingApprovalCount(),
  ]);
  return (
    <div className="agent-shell">
      <WorkspaceHeader current="/templates" pendingApprovalCount={pendingApprovalCount} />
      <main className="workspace-main" id="main" tabIndex={-1}>
        {env().AUTH_DISABLED && (
          <p className="local-auth-notice" role="status">
            Authentication disabled · Local development · {email}
          </p>
        )}
        <div className="page-heading">
          <div>
            <h1>Templates</h1>
            <p className="muted">
              A starting point for each agent. Edit the defaults here; existing agents keep their
              own configuration.
            </p>
          </div>
        </div>
        <div className="template-list">
          {items.map((template) => (
            <details key={template.id} className="template-row">
              <summary>
                <Layers size={18} aria-hidden="true" />
                <div>
                  <h2>{template.title}</h2>
                  <p className="muted">
                    {template.config.role || 'Start from a blank configuration'}
                  </p>
                </div>
                <span className="state-label">Revision {template.revision}</span>
                <ChevronDown size={14} className="disclosure-chevron" aria-hidden="true" />
              </summary>
              <WorkspaceForm
                key={template.revision}
                action={saveTemplate}
                label="Save template defaults"
                saveState
              >
                <input type="hidden" name="templateId" value={template.id} />
                <input type="hidden" name="revision" value={template.revision} />
                <ConfigFields template config={template.config} prefix={template.id} />
              </WorkspaceForm>
            </details>
          ))}
        </div>
      </main>
    </div>
  );
}
