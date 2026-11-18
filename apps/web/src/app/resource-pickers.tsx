'use client';

import { saveAgentMcpConnections } from '@/actions/mcp';
import { saveAgentSkills } from '@/actions/skills';
import { WorkspaceForm } from '@/app/workspace-form';

export function SkillPicker({
  agentId,
  skills,
  selectedIds,
}: {
  agentId: string;
  skills: { id: string; name: string; title: string; description: string; version: number }[];
  selectedIds: string[];
}) {
  const selected = new Set(selectedIds);
  return (
    <section id="skills" className="access-workbench">
      <div className="editor-section-heading">
        <h2>Skills</h2>
        <p className="muted">
          Attach shared skills. The model sees names and when-to-use descriptions; full bodies load
          through <code>load_skill</code>.
        </p>
      </div>
      {!skills.length ? (
        <p className="muted">
          No skills in the library yet. Create them under Skills in the workspace navigation.
        </p>
      ) : (
        <WorkspaceForm action={saveAgentSkills} label="Save skill selection" saveState>
          <input type="hidden" name="agentId" value={agentId} />
          <ul className="resource-picker-list">
            {skills.map((skill) => (
              <li key={skill.id}>
                <label className="resource-checkbox">
                  <input
                    type="checkbox"
                    name="skillId"
                    value={skill.id}
                    defaultChecked={selected.has(skill.id)}
                  />
                  <span>
                    <strong>{skill.title}</strong>
                    <span className="muted">
                      {' '}
                      · {skill.name} · v{skill.version}
                    </span>
                    <br />
                    <span className="muted">{skill.description}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </WorkspaceForm>
      )}
    </section>
  );
}

export function McpPicker({
  agentId,
  connections,
  selectedIds,
}: {
  agentId: string;
  connections: { id: string; name: string; url: string; transport: string }[];
  selectedIds: string[];
}) {
  const selected = new Set(selectedIds);
  return (
    <section id="mcp-connections" className="access-workbench">
      <div className="editor-section-heading">
        <h2>MCP connections</h2>
        <p className="muted">
          Attach shared MCP servers. Tools are registered at run time and every call is policy
          gated.
        </p>
      </div>
      {!connections.length ? (
        <p className="muted">
          No MCP connections yet. Create them under MCP in the workspace navigation.
        </p>
      ) : (
        <WorkspaceForm action={saveAgentMcpConnections} label="Save MCP selection" saveState>
          <input type="hidden" name="agentId" value={agentId} />
          <ul className="resource-picker-list">
            {connections.map((connection) => (
              <li key={connection.id}>
                <label className="resource-checkbox">
                  <input
                    type="checkbox"
                    name="connectionId"
                    value={connection.id}
                    defaultChecked={selected.has(connection.id)}
                  />
                  <span>
                    <strong>{connection.name}</strong>
                    <span className="muted"> · {connection.transport.toUpperCase()}</span>
                    <br />
                    <span className="muted">{connection.url}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </WorkspaceForm>
      )}
    </section>
  );
}
