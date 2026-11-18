'use client';

import { useState } from 'react';

import { saveAgentMcpConnections } from '@/actions/mcp';
import { saveAgentSkills } from '@/actions/skills';
import { WorkspaceForm } from '@/app/workspace-form';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';

export function SkillPicker({
  agentId,
  skills,
  selectedIds,
}: {
  agentId: string;
  skills: { id: string; name: string; title: string; description: string; version: number }[];
  selectedIds: string[];
}) {
  const [checked, setChecked] = useState<Record<string, boolean>>(() => {
    const selected = new Set(selectedIds);
    return Object.fromEntries(skills.map((skill) => [skill.id, selected.has(skill.id)]));
  });

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
          {skills.map((skill) =>
            checked[skill.id] ? (
              <input key={`hidden-${skill.id}`} type="hidden" name="skillId" value={skill.id} />
            ) : null,
          )}
          <FieldSet>
            <FieldLegend variant="label">Library skills</FieldLegend>
            <FieldDescription>Select the skills this agent may load during a run.</FieldDescription>
            <FieldGroup className="resource-picker-list gap-0" data-slot="checkbox-group">
              {skills.map((skill) => {
                const id = `skill-${skill.id}`;
                return (
                  <Field key={skill.id} orientation="horizontal" className="resource-picker-row">
                    <div className="resource-picker-copy">
                      <FieldLabel htmlFor={id} className="font-medium">
                        {skill.title}
                      </FieldLabel>
                      <FieldDescription>
                        {skill.name} · v{skill.version}
                      </FieldDescription>
                      <FieldDescription>{skill.description}</FieldDescription>
                    </div>
                    <Checkbox
                      id={id}
                      checked={checked[skill.id]}
                      onCheckedChange={(value) => {
                        setChecked((previous) => ({ ...previous, [skill.id]: value === true }));
                      }}
                      aria-label={skill.title}
                    />
                  </Field>
                );
              })}
            </FieldGroup>
          </FieldSet>
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
  const [checked, setChecked] = useState<Record<string, boolean>>(() => {
    const selected = new Set(selectedIds);
    return Object.fromEntries(
      connections.map((connection) => [connection.id, selected.has(connection.id)]),
    );
  });

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
          {connections.map((connection) =>
            checked[connection.id] ? (
              <input
                key={`hidden-${connection.id}`}
                type="hidden"
                name="connectionId"
                value={connection.id}
              />
            ) : null,
          )}
          <FieldSet>
            <FieldLegend variant="label">Library connections</FieldLegend>
            <FieldDescription>
              Select the MCP servers this agent may call during a run.
            </FieldDescription>
            <FieldGroup className="resource-picker-list gap-0" data-slot="checkbox-group">
              {connections.map((connection) => {
                const id = `mcp-${connection.id}`;
                return (
                  <Field
                    key={connection.id}
                    orientation="horizontal"
                    className="resource-picker-row"
                  >
                    <div className="resource-picker-copy">
                      <FieldLabel htmlFor={id} className="font-medium">
                        {connection.name}
                      </FieldLabel>
                      <FieldDescription>
                        {connection.transport.toUpperCase()} · {connection.url}
                      </FieldDescription>
                    </div>
                    <Checkbox
                      id={id}
                      checked={checked[connection.id]}
                      onCheckedChange={(value) => {
                        setChecked((previous) => ({
                          ...previous,
                          [connection.id]: value === true,
                        }));
                      }}
                      aria-label={connection.name}
                    />
                  </Field>
                );
              })}
            </FieldGroup>
          </FieldSet>
        </WorkspaceForm>
      )}
    </section>
  );
}
