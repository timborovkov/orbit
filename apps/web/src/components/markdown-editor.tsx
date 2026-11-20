'use client';

import { useDeferredValue, useRef, useState, type ComponentProps } from 'react';
import { Bold, Code, Heading2, Italic, Link2, List, ListOrdered, Quote } from 'lucide-react';
import { Streamdown } from 'streamdown';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

const commands = {
  heading: { label: 'Heading', icon: Heading2, prefix: '## ', line: true },
  bold: { label: 'Bold', icon: Bold, prefix: '**', suffix: '**', key: 'B' },
  italic: { label: 'Italic', icon: Italic, prefix: '*', suffix: '*', key: 'I' },
  link: { label: 'Link', icon: Link2, prefix: '[', suffix: '](https://)', key: 'K' },
  bulleted: { label: 'Bulleted list', icon: List, prefix: '- ', line: true },
  numbered: { label: 'Numbered list', icon: ListOrdered, prefix: '1. ', line: true },
  quote: { label: 'Quote', icon: Quote, prefix: '> ', line: true },
  code: { label: 'Code', icon: Code, prefix: '`', suffix: '`' },
} satisfies Record<
  string,
  {
    label: string;
    icon: typeof Bold;
    prefix: string;
    suffix?: string;
    line?: boolean;
    key?: string;
  }
>;

type Command = (typeof commands)[keyof typeof commands];
type Mode = 'write' | 'preview' | 'split';

type MarkdownEditorProps = Omit<
  ComponentProps<'textarea'>,
  'className' | 'defaultValue' | 'onChange' | 'value' | 'ref'
> & {
  value: string;
  onValueChange: (value: string) => void;
  large?: boolean;
};

export function MarkdownEditor({
  value,
  onValueChange,
  large = false,
  ...props
}: MarkdownEditorProps) {
  const [mode, setMode] = useState<Mode>('write');
  const source = useRef<HTMLTextAreaElement>(null);
  const preview = useDeferredValue(value);
  const canFormat = mode !== 'preview' && !props.disabled && !props.readOnly;

  function format(command: Command) {
    const input = source.current;
    if (!input || !canFormat) return;

    let { selectionStart: start, selectionEnd: end } = input;
    const onLines = 'line' in command;
    if (onLines) {
      start = start === 0 ? 0 : input.value.lastIndexOf('\n', start - 1) + 1;
      const lastSelected = end > start && input.value[end - 1] === '\n' ? end - 1 : end;
      const nextLine = input.value.indexOf('\n', lastSelected);
      end = nextLine === -1 ? input.value.length : nextLine;
    }

    const selected = input.value.slice(start, end);
    const codeBlock = command === commands.code && selected.includes('\n');
    const prefix = codeBlock ? '```\n' : command.prefix;
    const suffix = codeBlock ? '\n```' : 'suffix' in command ? command.suffix : '';
    const replacement = onLines
      ? selected
          .split('\n')
          .map((line) => command.prefix + line)
          .join('\n')
      : prefix + selected + suffix;

    if (
      props.maxLength !== undefined &&
      input.value.length - selected.length + replacement.length > props.maxLength
    )
      return;

    input.focus({ preventScroll: true });
    input.setSelectionRange(start, end);
    // The DOM replacement APIs don't participate in native textarea undo.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    if (!document.execCommand('insertText', false, replacement)) {
      input.setRangeText(replacement, start, end, 'end');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    const innerStart = start + prefix.length;
    const innerEnd = start + replacement.length - suffix.length;
    if (command === commands.link && selected) {
      input.setSelectionRange(innerEnd + 2, innerEnd + suffix.length - 1);
    } else {
      input.setSelectionRange(selected ? innerStart : innerEnd, innerEnd);
    }
  }

  return (
    <Tabs
      value={mode}
      onValueChange={(next) => {
        setMode(next as Mode);
      }}
      className={cn('markdown-editor', large && 'markdown-editor-large')}
    >
      <div className="markdown-toolbar">
        <div className="markdown-format" role="group" aria-label="Markdown formatting">
          {Object.entries(commands).map(([key, command]) => {
            const shortcut = 'key' in command ? command.key : undefined;
            return (
              <button
                key={key}
                type="button"
                aria-label={command.label}
                aria-keyshortcuts={shortcut ? `Control+${shortcut} Meta+${shortcut}` : undefined}
                title={shortcut ? `${command.label} (Ctrl/⌘+${shortcut})` : command.label}
                disabled={!canFormat}
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                onClick={() => {
                  format(command);
                }}
              >
                <command.icon size={16} aria-hidden="true" />
              </button>
            );
          })}
        </div>
        <TabsList aria-label="Markdown view" className="markdown-tabs">
          <TabsTrigger value="write">Write</TabsTrigger>
          <TabsTrigger value="preview">Preview</TabsTrigger>
          <TabsTrigger value="split">Split</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value={mode} className="markdown-panes" data-mode={mode}>
        <Textarea
          {...props}
          ref={source}
          hidden={mode === 'preview'}
          className="markdown-source resize-none"
          value={value}
          onChange={(event) => {
            onValueChange(event.currentTarget.value);
          }}
          onInvalid={(event) => {
            props.onInvalid?.(event);
            if (mode !== 'preview') return;
            event.preventDefault();
            setMode('write');
            requestAnimationFrame(() => {
              source.current?.reportValidity();
            });
          }}
          onKeyDown={(event) => {
            props.onKeyDown?.(event);
            if (
              event.defaultPrevented ||
              (!event.metaKey && !event.ctrlKey) ||
              event.altKey ||
              event.shiftKey
            )
              return;
            const command = Object.values(commands).find(
              (item) => 'key' in item && item.key.toLowerCase() === event.key.toLowerCase(),
            );
            if (command && canFormat) {
              event.preventDefault();
              format(command);
            }
          }}
        />
        {mode !== 'write' && (
          <div className="markdown-preview">
            {preview.trim() ? (
              <Streamdown
                mode="static"
                controls={false}
                skipHtml
                rehypePlugins={[]}
                disallowedElements={['img']}
              >
                {preview}
              </Streamdown>
            ) : (
              <p className="muted">Nothing to preview yet.</p>
            )}
          </div>
        )}
      </TabsContent>
    </Tabs>
  );
}
