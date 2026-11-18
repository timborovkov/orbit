import { WorkspaceHeader } from '@/app/workspace-header';
import { SkillsLibrary } from '@/components/skills-library';
import { env } from '@/lib/env';
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
        <SkillsLibrary
          items={items.map((skill) => ({
            id: skill.id,
            name: skill.name,
            title: skill.title,
            description: skill.description,
            body: skill.body,
            version: skill.version,
            agentCount: skill.agentCount,
            updatedAt: skill.updatedAt.toISOString(),
          }))}
        />
      </main>
    </div>
  );
}
