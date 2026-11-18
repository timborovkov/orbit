'use client';

import { useEffect, useId, useState } from 'react';

export function WorkspaceTabs({
  items,
}: {
  items: { id: string; label: string; count?: number; content: React.ReactNode }[];
}) {
  const prefix = useId();
  const [selected, setSelected] = useState(items[0]?.id);
  useEffect(() => {
    if (!selected) return;
    document
      .getElementById(`${prefix}-${selected}-tab`)
      ?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
  }, [prefix, selected]);
  return (
    <>
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
              else if (event.key === 'ArrowLeft') next = (index - 1 + items.length) % items.length;
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
      {items.map((item) => (
        <div
          key={item.id}
          className="workspace-tab-panel"
          id={`${prefix}-${item.id}`}
          role="tabpanel"
          aria-labelledby={`${prefix}-${item.id}-tab`}
          hidden={selected !== item.id}
        >
          {item.content}
        </div>
      ))}
    </>
  );
}
