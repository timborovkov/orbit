import { BookOpen, ChevronDown } from 'lucide-react';

import { removeSkill, saveSkill } from '@/actions/skills';
import { WorkspaceField } from '@/app/workspace-field';
import { WorkspaceForm } from '@/app/workspace-form';
import { WorkspaceHeader } from '@/app/workspace-header';
import { SubmitButton } from '@/components/ui/submit-button';
import { env } from '@/lib/env';
import { formatUtcTimestamp } from '@/lib/format';
import { listSkills } from '@/lib/server/skills-queries';

export const dynamic = 'force-dynamic';

export default async function SkillsPage() {
  const { email, items } = await listSkills();
  return (
    <div className="agent-shell">
      <WorkspaceHeader name="Skills" />
      <main className="agent-main">
        {env().AUTH_DISABLED && (
          <p className="local-auth-notice" role="status">
            Authentication disabled · Local development · {email}
          </p>
        )}
        <div className="template-page-heading">
          <h1>Skills</h1>
          <p className="muted">
            Shared Markdown skills. Agents opt in from Access; prompts only receive names and
            descriptions until <code>load_skill</code> fetches a body.
          </p>
        </div>

        <section className="surface resource-create" aria-labelledby="create-skill-title">
          <div className="editor-section-heading">
            <h2 id="create-skill-title">New skill</h2>
            <p className="muted">Define a reusable skill once, then attach it to any agent.</p>
          </div>
          <WorkspaceForm action={saveSkill} label="Create skill">
            <div className="resource-form-grid">
              <WorkspaceField
                id="new-skill-name"
                name="name"
                label="Slug"
                required
                maxLength={80}
              />
              <WorkspaceField
                id="new-skill-title"
                name="title"
                label="Title"
                required
                maxLength={120}
              />
            </div>
            <WorkspaceField
              id="new-skill-description"
              name="description"
              label="When to use"
              required
              multiline
              rows={2}
              maxLength={500}
            />
            <WorkspaceField
              id="new-skill-body"
              name="body"
              label="Markdown body"
              required
              multiline
              rows={8}
              maxLength={100000}
            />
          </WorkspaceForm>
        </section>

        <div className="template-list">
          {!items.length && (
            <div className="history-empty">
              <BookOpen size={24} aria-hidden="true" />
              <p>No skills yet. Create one above.</p>
            </div>
          )}
          {items.map((skill) => (
            <details key={skill.id} className="template-row">
              <summary>
                <BookOpen size={18} aria-hidden="true" />
                <div>
                  <h2>{skill.title}</h2>
                  <p className="muted">
                    {skill.name} · {skill.description}
                  </p>
                </div>
                <span className="state-label">v{skill.version}</span>
                <ChevronDown size={14} className="disclosure-chevron" aria-hidden="true" />
              </summary>
              <WorkspaceForm
                key={`${skill.id}-${skill.version}`}
                action={saveSkill}
                label="Save skill"
                saveState
              >
                <input type="hidden" name="skillId" value={skill.id} />
                <div className="resource-form-grid">
                  <WorkspaceField
                    id={`skill-name-${skill.id}`}
                    name="name"
                    label="Slug"
                    required
                    maxLength={80}
                    initialValue={skill.name}
                  />
                  <WorkspaceField
                    id={`skill-title-${skill.id}`}
                    name="title"
                    label="Title"
                    required
                    maxLength={120}
                    initialValue={skill.title}
                  />
                </div>
                <WorkspaceField
                  id={`skill-description-${skill.id}`}
                  name="description"
                  label="When to use"
                  required
                  multiline
                  rows={2}
                  maxLength={500}
                  initialValue={skill.description}
                />
                <WorkspaceField
                  id={`skill-body-${skill.id}`}
                  name="body"
                  label="Markdown body"
                  required
                  multiline
                  rows={10}
                  maxLength={100000}
                  initialValue={skill.body}
                />
                <p className="field-hint">
                  Updated {formatUtcTimestamp(skill.updatedAt)} · Saving bumps the version when
                  content changes.
                </p>
              </WorkspaceForm>
              <form action={removeSkill} className="resource-delete">
                <input type="hidden" name="skillId" value={skill.id} />
                <SubmitButton variant="destructive" pendingLabel="Deleting…">
                  Delete skill
                </SubmitButton>
              </form>
            </details>
          ))}
        </div>
      </main>
    </div>
  );
}
