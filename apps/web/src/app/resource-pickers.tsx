'use client';

import { useState } from 'react';

import { saveAgentMcpConnections } from '@/actions/mcp';
import { saveAgentSkills } from '@/actions/skills';
import { WorkspaceForm } from '@/app/workspace-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import type { AgentMcpSelection } from '@/lib/mcp-allowlist';

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
          <Card className="budget-card shadow-none">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Library skills</CardTitle>
              <CardDescription>Select the skills this agent may load during a run.</CardDescription>
            </CardHeader>
            <CardContent>
              <FieldSet>
                <FieldLegend className="sr-only">Library skills</FieldLegend>
                <FieldGroup className="approval-tool-list gap-0" data-slot="checkbox-group">
                  {skills.map((skill) => {
                    const id = `skill-${skill.id}`;
                    return (
                      <Field key={skill.id} orientation="horizontal" className="approval-tool-row">
                        <div className="approval-tool-copy">
                          <FieldLabel htmlFor={id} className="font-medium">
                            {skill.title}
                          </FieldLabel>
                          <FieldDescription>
                            {skill.name} · v{skill.version}
                          </FieldDescription>
                          <FieldDescription className="text-pretty">
                            {skill.description}
                          </FieldDescription>
                        </div>
                        <Checkbox
                          id={id}
                          checked={checked[skill.id]}
                          onCheckedChange={(value) => {
                            setChecked((previous) => ({
                              ...previous,
                              [skill.id]: value === true,
                            }));
                          }}
                          aria-label={skill.title}
                        />
                      </Field>
                    );
                  })}
                </FieldGroup>
              </FieldSet>
            </CardContent>
          </Card>
        </WorkspaceForm>
      )}
    </section>
  );
}

export interface McpPickerConnection {
  id: string;
  name: string;
  url: string;
  transport: string;
  revision: string;
  readOnlyTools: string[];
}

export function McpPicker({
  agentId,
  connections,
  selections,
}: {
  agentId: string;
  connections: McpPickerConnection[];
  selections: AgentMcpSelection[];
}) {
  const [selected, setSelected] = useState<Record<string, Set<string> | undefined>>(() =>
    Object.fromEntries(
      selections.map(({ connectionId, toolNames }) => [connectionId, new Set(toolNames)]),
    ),
  );
  const submitted = connections.flatMap(({ id, revision, readOnlyTools }) => {
    const toolNames = selected[id];
    return toolNames
      ? [
          {
            connectionId: id,
            revision,
            toolNames: readOnlyTools.filter((name) => toolNames.has(name)),
          },
        ]
      : [];
  });

  return (
    <section id="mcp-connections" className="access-workbench">
      <div className="editor-section-heading">
        <h2>MCP connections</h2>
        <p className="muted">
          Attach shared MCP servers and choose which read-only tools this agent can use.
        </p>
      </div>
      {!connections.length ? (
        <p className="muted">
          No MCP connections yet. Create them under MCP in the workspace navigation.
        </p>
      ) : (
        <WorkspaceForm action={saveAgentMcpConnections} label="Save MCP selection" saveState>
          <input type="hidden" name="agentId" value={agentId} />
          <input type="hidden" name="selections" value={JSON.stringify(submitted)} />
          <Card className="budget-card shadow-none">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Library connections</CardTitle>
              <CardDescription>
                Attach a connection to grant its tools individually.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <FieldSet>
                <FieldLegend className="sr-only">Library connections</FieldLegend>
                <FieldGroup className="approval-tool-list gap-0" data-slot="checkbox-group">
                  {connections.map((connection) => {
                    const id = `mcp-${connection.id}`;
                    const grants = selected[connection.id];
                    return (
                      <div key={connection.id}>
                        <Field orientation="horizontal" className="approval-tool-row">
                          <div className="approval-tool-copy">
                            <FieldLabel htmlFor={id} className="font-medium">
                              {connection.name}
                            </FieldLabel>
                            <FieldDescription className="text-pretty">
                              {connection.transport.toUpperCase()} · {connection.url}
                            </FieldDescription>
                          </div>
                          <Checkbox
                            id={id}
                            checked={Boolean(grants)}
                            onCheckedChange={(value) => {
                              setSelected((previous) => ({
                                ...previous,
                                [connection.id]: value === true ? new Set<string>() : undefined,
                              }));
                            }}
                            aria-label={connection.name}
                          />
                        </Field>
                        {grants && (
                          <FieldSet className="ms-4 gap-0 pb-3">
                            <FieldLegend className="sr-only">
                              {connection.name} read-only tools
                            </FieldLegend>
                            {!connection.readOnlyTools.length && (
                              <FieldDescription>No read-only tools configured.</FieldDescription>
                            )}
                            {connection.readOnlyTools.map((name, index) => (
                              <Field
                                orientation="horizontal"
                                className="approval-tool-row"
                                key={name}
                              >
                                <FieldLabel htmlFor={`${id}-tool-${index}`}>{name}</FieldLabel>
                                <Checkbox
                                  id={`${id}-tool-${index}`}
                                  checked={grants.has(name)}
                                  onCheckedChange={(value) => {
                                    setSelected((previous) => {
                                      const next = new Set(previous[connection.id]);
                                      if (value === true) next.add(name);
                                      else next.delete(name);
                                      return { ...previous, [connection.id]: next };
                                    });
                                  }}
                                />
                              </Field>
                            ))}
                          </FieldSet>
                        )}
                      </div>
                    );
                  })}
                </FieldGroup>
              </FieldSet>
            </CardContent>
          </Card>
        </WorkspaceForm>
      )}
    </section>
  );
}
