'use client';

import { useEffect, useId, useRef, useState } from 'react';

import { useSearchParams } from 'next/navigation';

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
  const [selectedTab, setSelectedTab] = useState<string>();
  const [compact, setCompact] = useState(false);
  const openedHistoryRun = useRef<HTMLDetailsElement | null>(null);
  const search = useSearchParams();
  const historyRunId = search.get('run');
  const emailRequested = search.get('tab') === 'email';
  const linkedTab = historyRunId ? 'history' : emailRequested ? 'email' : undefined;
  const selected = linkedTab ?? selectedTab ?? items.at(0)?.id;

  function selectTab(id: string) {
    if (linkedTab && id !== linkedTab) {
      const url = new URL(window.location.href);
      for (const key of ['run', 'tab', 'emailThread', 'emailPage', 'messagePage']) {
        url.searchParams.delete(key);
      }
      window.history.replaceState(null, '', url);
      openedHistoryRun.current = null;
    }
    setSelectedTab(id);
  }

  useEffect(() => {
    if (!historyRunId) return;
    const run = document.getElementById(`run-${historyRunId}`);
    if (!(run instanceof HTMLDetailsElement) || openedHistoryRun.current === run) return;
    openedHistoryRun.current = run;
    run.open = true;
    run.scrollIntoView({ block: 'start' });
    run.querySelector('summary')?.focus({ preventScroll: true });
  }, [historyRunId, items]);

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
    if (!selected || compact || historyRunId) return;
    document
      .getElementById(`${prefix}-${selected}-tab`)
      ?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
  }, [compact, historyRunId, prefix, selected]);

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
              selectTab(value);
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
                  selectTab(item.id);
                }}
                onKeyDown={(event) => {
                  let next: number;
                  if (event.key === 'ArrowRight') next = (index + 1) % items.length;
                  else if (event.key === 'ArrowLeft')
                    next = (index - 1 + items.length) % items.length;
                  else if (event.key === 'Home') next = 0;
                  else if (event.key === 'End') next = items.length - 1;
                  else return;
                  event.preventDefault();
                  const target = items[next];
                  selectTab(target.id);
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
