import { SkillsLibrary } from '@/components/skills-library';
import { env } from '@/lib/env';
import { listSkills } from '@/lib/server/skills-queries';
import { listAgentOptions } from '@/lib/server/workspace-queries';

export const dynamic = 'force-dynamic';

export default async function SkillsPage() {
  const [{ email, items }, agents] = await Promise.all([listSkills(), listAgentOptions()]);
  return (
    <main className="workspace-main" id="main" tabIndex={-1}>
      {env().AUTH_DISABLED && (
        <p className="local-auth-notice" role="status">
          Authentication disabled · Local development · {email}
        </p>
      )}
      <SkillsLibrary
        agents={agents}
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
  );
}
