'use client';

import { useEffect, useId, useState } from 'react';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export function WorkspaceTabs({
  items,
}: {
  items: { id: string; label: string; count?: number; content: React.ReactNode }[];
}) {
  const prefix = useId();
  const [selected, setSelected] = useState(items[0]?.id);
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 600px)');
    const sync = () => {
      setCompact(media.matches);
    };
    sync();
    media.addEventListener('change', sync);
    return () => {
      media.removeEventListener('change', sync);
    };
  }, []);

  useEffect(() => {
    if (!selected || compact) return;
    document
      .getElementById(`${prefix}-${selected}-tab`)
      ?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
  }, [compact, prefix, selected]);

  return (
    <>
      {compact ? (
        <div className="agent-tabs-compact">
          <label className="sr-only" htmlFor={`${prefix}-compact`}>
            Agent workspace section
          </label>
          <Select
            value={selected}
            onValueChange={(value) => {
              setSelected(value);
            }}
          >
            <SelectTrigger
              id={`${prefix}-compact`}
              className="agent-tabs-compact-trigger w-full"
              aria-label="Agent workspace section"
            >
              <SelectValue placeholder="Section" />
            </SelectTrigger>
            <SelectContent>
              {items.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.label}
                  {item.count !== undefined ? ` ${item.count}` : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : (
        <div className="agent-tabs-shell">
          <div className="agent-tabs" role="tablist" aria-label="Agent workspace">
            {items.map((item, index) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                id={`${prefix}-${item.id}-tab`}
                aria-controls={`${prefix}-${item.id}`}
                aria-selected={selected === item.id}
                tabIndex={selected === item.id ? 0 : -1}
                onClick={() => {
                  setSelected(item.id);
                }}
                onKeyDown={(event) => {
                  let next = index;
                  if (event.key === 'ArrowRight') next = (index + 1) % items.length;
                  else if (event.key === 'ArrowLeft')
                    next = (index - 1 + items.length) % items.length;
                  else if (event.key === 'Home') next = 0;
                  else if (event.key === 'End') next = items.length - 1;
                  else return;
                  event.preventDefault();
                  const target = items[next];
                  setSelected(target.id);
                  document.getElementById(`${prefix}-${target.id}-tab`)?.focus();
                }}
              >
                {item.label}
                {item.count !== undefined && <span className="tab-count">{item.count}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
      {items.map((item) => (
        <div
          key={item.id}
          className="workspace-tab-panel"
          id={`${prefix}-${item.id}`}
          role="tabpanel"
          aria-labelledby={compact ? `${prefix}-compact` : `${prefix}-${item.id}-tab`}
          hidden={selected !== item.id}
        >
          {item.content}
        </div>
      ))}
    </>
  );
}
