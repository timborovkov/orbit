'use client';

import { type ReactNode, useState } from 'react';

import { Cpu, Fingerprint, Radar, SlidersHorizontal } from 'lucide-react';

import { WorkspaceField } from '@/app/workspace-field';
import { TermHint } from '@/components/term-hint';
import { type AgentConfig, configFields } from '@/lib/runtime/config';

const shortFields = new Set(['name', 'role', 'mainModel', 'evaluatorModel', 'xSearchQuery']);
const requiredFields = new Set(['name', 'mainModel', 'evaluatorModel']);
const definitions = new Map<string, (typeof configFields)[number]>(
  configFields.map((field) => [field[0], field]),
);

const groups = [
  {
    id: 'identity',
    title: 'Identity',
    icon: Fingerprint,
    description: 'Define who this agent is and what it is here to do.',
    fields: ['name', 'role', 'mission', 'personality'],
  },
  {
    id: 'behaviour',
    title: 'Behaviour',
    icon: SlidersHorizontal,
    description: 'Set the operating rules and when this agent should engage.',
    fields: ['instructions', 'engagementCriteria'],
  },
  {
    id: 'discovery',
    title: 'Discovery',
    icon: Radar,
    description: 'Configure proactive X search. Polling stays read-only in shadow mode.',
    fields: ['xSearchQuery'],
  },
  {
    id: 'models',
    title: 'Models',
    icon: Cpu,
    description: 'Choose the models that evaluate inputs and compose responses.',
    fields: ['mainModel', 'evaluatorModel'],
  },
];
export function ConfigFields({
  config,
  prefix,
  template = false,
  identityContent,
}: {
  config: AgentConfig;
  prefix: string;
  template?: boolean;
  identityContent?: ReactNode;
}) {
  const [active, setActive] = useState('identity');
  return (
    <div
      className="config-editor"
      onInvalidCapture={(event) => {
        const field = event.target;
        if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) return;
        const group = groups.find((group) => group.fields.includes(field.name));
        if (group) {
          setActive(group.id);
          requestAnimationFrame(() => {
            field.focus();
          });
        }
      }}
    >
      <nav className="config-sections" aria-label="Configuration sections">
        {groups.map((group) => (
          <button
            key={group.id}
            type="button"
            aria-pressed={active === group.id}
            onClick={() => {
              setActive(group.id);
            }}
          >
            <group.icon size={16} aria-hidden="true" />
            {group.title}
          </button>
        ))}
      </nav>
      <div className="config-fields-body">
        {groups.map((group) => (
          <section
            key={group.id}
            className="config-field-panel"
            hidden={active !== group.id}
            aria-labelledby={`${prefix}-${group.id}-title`}
          >
            <div className="editor-section-heading">
              <h2 id={`${prefix}-${group.id}-title`}>{group.title}</h2>
              <p className="muted">{group.description}</p>
            </div>
            {group.id === 'identity' && identityContent}
            <div className={`editor-fields editor-fields-${group.id}`}>
              {group.fields.map((key) => {
                const definition = definitions.get(key);
                if (!definition || (template && key === 'name')) return null;
                const [name, label] = definition;
                const short = shortFields.has(name);
                return (
                  <WorkspaceField
                    key={name}
                    id={`${prefix}-${name}`}
                    name={name}
                    label={label}
                    initialValue={config[name]}
                    required={requiredFields.has(name)}
                    markdown={!short}
                    compactMarkdown={name === 'personality'}
                    description={
                      name === 'mission'
                        ? 'Describe the outcome this agent should work towards.'
                        : undefined
                    }
                    maxLength={
                      name === 'name'
                        ? 80
                        : name === 'mainModel' || name === 'evaluatorModel'
                          ? 160
                          : name === 'xSearchQuery'
                            ? 512
                            : name === 'mission'
                              ? 2000
                              : 12000
                    }
                  />
                );
              })}
            </div>
            {group.id === 'discovery' && (
              <p className="field-hint">
                One X recent-search query per agent. Leave blank to disable polling. New posts are
                stored and evaluated in shadow mode; proposals are recorded and never sent.
              </p>
            )}
            {group.id === 'models' && (
              <p className="field-hint">
                Use an OpenRouter model ID. Both steps can use the same model. Keys are managed
                under Access; an optional{' '}
                <TermHint hint="Set as OPENROUTER_API_KEY on the server">
                  server default key
                </TermHint>{' '}
                covers agents without their own key.
              </p>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
