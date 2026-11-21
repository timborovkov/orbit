'use client';

import { type ReactNode, useMemo, useState } from 'react';

import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, isToolUIPart } from 'ai';
import {
  ArrowUp,
  ChevronDown,
  Clock3,
  Eraser,
  FlaskConical,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';

import { KnowledgeToolResult } from '@/app/knowledge-citations';
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import { Loader } from '@/components/ai-elements/loader';
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from '@/components/ai-elements/prompt-input';
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning';
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { PlaygroundUIMessage } from '@/lib/runtime/chat-ui';
import {
  PLAYGROUND_ATTACHMENTS_UNSUPPORTED,
  playgroundAttachmentRejection,
  playgroundEffectiveConfigurationId,
  type PlaygroundVersionSelection,
} from '@/lib/runtime/playground-ui';
import { cn } from '@/lib/utils';

interface AgentVersion {
  id: string;
  version: number;
  name: string;
}

function lifecycleBlockMessage(lifecycle: string) {
  return lifecycle === 'paused'
    ? 'This agent is paused. Resume it under Access before queueing simulations.'
    : 'This agent is stopped. Change its lifecycle under Access before queueing simulations.';
}

function queuedRunId({ type, data }: { type: string; data: unknown }) {
  if (
    type === 'data-run' &&
    typeof data === 'object' &&
    data !== null &&
    'id' in data &&
    typeof data.id === 'string'
  ) {
    return data.id;
  }
  return null;
}

function isStatusText(text: string) {
  return (
    text.startsWith('Simulation queued') ||
    text.startsWith('Timed out waiting') ||
    text.includes('No OpenRouter credential')
  );
}

export function PlaygroundChat({
  agentId,
  agentName,
  canSimulate,
  lifecycle,
  versions,
  currentConfigurationId,
  latestRun,
  runStatuses,
}: {
  agentId: string;
  agentName: string;
  canSimulate: boolean;
  lifecycle: string;
  versions: AgentVersion[];
  currentConfigurationId: string;
  latestRun?: ReactNode;
  runStatuses: Record<string, string>;
}) {
  const router = useRouter();
  const [versionSelection, setVersionSelection] = useState<PlaygroundVersionSelection>({
    baseId: currentConfigurationId,
    overrideId: null,
  });
  const configurationId = playgroundEffectiveConfigurationId(
    versionSelection,
    currentConfigurationId,
  );
  const [recipient, setRecipient] = useState('');
  const [otherRecipient, setOtherRecipient] = useState('');
  const [recipientsOpen, setRecipientsOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [stoppedWatching, setStoppedWatching] = useState(false);

  const transport = useMemo(
    () =>
      new DefaultChatTransport<PlaygroundUIMessage>({
        api: `/api/agents/${agentId}/chat`,
        credentials: 'same-origin',
        prepareSendMessagesRequest: ({ body }) => ({ body: body ?? {} }),
      }),
    [agentId],
  );

  const { messages, sendMessage, status, stop, error, setMessages, clearError } =
    useChat<PlaygroundUIMessage>({
      transport,
      onData: (part) => {
        const id = queuedRunId(part);
        if (!id) return;
        setRunId(id);
        router.refresh();
      },
      onFinish: () => {
        router.refresh();
      },
    });

  const busy = status === 'submitted' || status === 'streaming';

  function onSubmit(input: string) {
    setFormError(null);
    const text = input.trim();
    if (!text) {
      setFormError('Paste a post or question with 1–16,000 characters.');
      return;
    }
    if (!canSimulate) {
      setFormError(lifecycleBlockMessage(lifecycle));
      return;
    }
    const recipients = [recipient, otherRecipient].map((value) => value.trim()).filter(Boolean);
    setRunId(null);
    setStoppedWatching(false);
    void sendMessage({ text }, { body: { input: text, configurationId, recipients } });
  }

  return (
    <div className="playground-chat">
      <div className="playground-chat-heading">
        <div>
          <h2>Test a conversation</h2>
          <p className="muted">See how {agentName} would respond to a post or question.</p>
        </div>
        {messages.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            className="playground-clear"
            onClick={() => {
              setMessages([]);
              clearError();
              setFormError(null);
              setRunId(null);
              setStoppedWatching(false);
            }}
            disabled={busy}
          >
            <Eraser size={16} aria-hidden="true" />
            Clear conversation
          </Button>
        )}
      </div>

      {!canSimulate && (
        <div className="run-notice">
          <ShieldCheck size={18} aria-hidden="true" />
          <p>{lifecycleBlockMessage(lifecycle)}</p>
        </div>
      )}

      {latestRun}

      <div className="playground-toolbar">
        <Field className="playground-version-field gap-2">
          <FieldLabel htmlFor="run-version">Configuration version</FieldLabel>
          <Select
            value={configurationId}
            onValueChange={(value) => {
              setVersionSelection({ baseId: currentConfigurationId, overrideId: value });
            }}
          >
            <SelectTrigger
              id="run-version"
              className="w-full min-w-0 bg-background text-foreground"
              aria-label="Configuration version"
            >
              <SelectValue placeholder="Choose a version" />
            </SelectTrigger>
            <SelectContent>
              {versions.map((version) => (
                <SelectItem key={version.id} value={version.id}>
                  Version {version.version} · {version.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Collapsible
          open={recipientsOpen}
          onOpenChange={setRecipientsOpen}
          className="playground-recipients"
        >
          <FieldLabel htmlFor="playground-consent-recipients">Consent checks</FieldLabel>
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="outline"
              id="playground-consent-recipients"
              className="playground-recipients-trigger"
              aria-label="Recipients for consent checks"
            >
              Recipients
              <ChevronDown
                size={16}
                aria-hidden="true"
                className={cn('playground-recipients-chevron', recipientsOpen && 'is-open')}
              />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="playground-recipients-content">
            <Field>
              <FieldLabel htmlFor="run-recipient">Recipient ID</FieldLabel>
              <Input
                id="run-recipient"
                name="recipient"
                maxLength={120}
                value={recipient}
                disabled={busy}
                onChange={(event) => {
                  setRecipient(event.target.value);
                }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="run-other-recipient">
                Second recipient ID (introductions)
              </FieldLabel>
              <Input
                id="run-other-recipient"
                name="otherRecipient"
                maxLength={120}
                value={otherRecipient}
                disabled={busy}
                onChange={(event) => {
                  setOtherRecipient(event.target.value);
                }}
              />
            </Field>
            <p className="field-hint">Use the same IDs as the consent records in Access.</p>
          </CollapsibleContent>
        </Collapsible>
      </div>

      <div className="playground-chat-shell">
        <PlaygroundConversation
          agentId={agentId}
          messages={messages}
          busy={busy}
          queued={Boolean(runId)}
          hasLatestRun={Boolean(latestRun)}
          runStatuses={runStatuses}
        />

        <PlaygroundComposer
          canSimulate={canSimulate}
          busy={busy}
          runId={runId}
          stoppedWatching={stoppedWatching}
          streamError={error?.message}
          formError={formError}
          onSubmit={onSubmit}
          onAttachment={() => {
            setFormError(
              playgroundAttachmentRejection([{ filename: 'attachment' }]) ??
                PLAYGROUND_ATTACHMENTS_UNSUPPORTED,
            );
          }}
          onStopWatching={() => {
            setStoppedWatching(true);
            void stop();
            router.refresh();
          }}
        />
      </div>
    </div>
  );
}

function PlaygroundComposer({
  canSimulate,
  busy,
  runId,
  stoppedWatching,
  streamError,
  formError,
  onSubmit,
  onAttachment,
  onStopWatching,
}: {
  canSimulate: boolean;
  busy: boolean;
  runId: string | null;
  stoppedWatching: boolean;
  streamError?: string;
  formError: string | null;
  onSubmit: (input: string) => void;
  onAttachment: () => void;
  onStopWatching: () => void;
}) {
  const error = formError ?? streamError;

  return (
    <div className="playground-composer">
      <PromptInput
        className={cn('playground-prompt', !canSimulate && 'is-disabled')}
        onAttachment={onAttachment}
        onSubmit={onSubmit}
      >
        <PromptInputTextarea
          aria-label="Post or question"
          placeholder="Paste a post or question…"
          disabled={!canSimulate || busy}
          maxLength={16000}
          className="resize-none border-0 bg-transparent shadow-none focus-visible:border-0 focus-visible:ring-0"
        />
        <PromptInputFooter>
          <PromptInputTools>
            <p className="simulation-note">
              <ShieldCheck size={15} aria-hidden="true" />
              <span>
                Nothing is posted or sent. Model usage can incur charges. Save your configuration
                before testing.
              </span>
            </p>
          </PromptInputTools>
          {busy && runId ? (
            <Button type="button" size="sm" variant="outline" onClick={onStopWatching}>
              Stop watching
            </Button>
          ) : (
            <PromptInputSubmit
              disabled={!canSimulate || busy}
              size="icon-sm"
              className="playground-submit"
            >
              <ArrowUp className="size-4" aria-hidden="true" />
            </PromptInputSubmit>
          )}
        </PromptInputFooter>
      </PromptInput>

      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {runId && (stoppedWatching || streamError) && (
        <div className="playground-watch-notice">
          {stoppedWatching && <span role="status">Stopped watching. Inference may continue.</span>}
          <Link href={`?run=${runId}`} scroll={false} prefetch={false}>
            Open run in History
          </Link>
        </div>
      )}
    </div>
  );
}

function PlaygroundConversation({
  agentId,
  messages,
  busy,
  queued,
  hasLatestRun,
  runStatuses,
}: {
  agentId: string;
  messages: PlaygroundUIMessage[];
  busy: boolean;
  queued: boolean;
  hasLatestRun: boolean;
  runStatuses: Record<string, string>;
}) {
  const empty = messages.length === 0 && !busy;

  return (
    <Conversation className="playground-conversation" data-empty={empty || undefined}>
      <ConversationContent>
        {empty && (
          <ConversationEmptyState
            icon={<FlaskConical size={30} strokeWidth={1.25} aria-hidden="true" />}
            title={hasLatestRun ? 'Start a new simulation' : 'No messages yet'}
            description="Paste a post or question to see the evaluation, proposed actions and drafts."
          />
        )}
        {messages.map((message) => (
          <PlaygroundMessage
            key={message.id}
            message={message}
            agentId={agentId}
            runStatuses={runStatuses}
          />
        ))}
        {busy && (
          <Message from="assistant">
            <MessageContent>
              <div className="playground-status" role="status">
                <Loader />
                <span>
                  {queued ? 'Simulation queued. Watching for results…' : 'Queueing simulation…'}
                </span>
              </div>
            </MessageContent>
          </Message>
        )}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}

function PlaygroundStatusPart({ text }: { text: string }) {
  const failed = /failed|error|credential|timed out/i.test(text);
  return (
    <div className={cn('playground-status', failed && 'is-error')} role="status">
      {failed ? <TriangleAlert size={16} aria-hidden="true" /> : <Loader />}
      <span>{text}</span>
    </div>
  );
}

function PlaygroundTextPart({ text }: { text: string }) {
  if (isStatusText(text)) return <PlaygroundStatusPart text={text} />;
  return <MessageResponse>{text}</MessageResponse>;
}

function PlaygroundReasoningPart({ text, state }: { text: string; state?: 'streaming' | 'done' }) {
  const streaming = state === 'streaming';
  return (
    <Reasoning isStreaming={streaming} defaultOpen={streaming}>
      <ReasoningTrigger />
      <ReasoningContent>{text}</ReasoningContent>
    </Reasoning>
  );
}

function PlaygroundToolPart({
  part,
}: {
  part: Extract<
    PlaygroundUIMessage['parts'][number],
    { type: `tool-${string}` } | { type: 'dynamic-tool' }
  >;
}) {
  const title = part.type.replace(/^tool-/, '');
  const toolType: `tool-${string}` =
    part.type === 'dynamic-tool' ? `tool-${title || 'action'}` : part.type;
  return (
    <Tool defaultOpen>
      <ToolHeader type={toolType} state={part.state} title={title} />
      <ToolContent>
        {'input' in part && part.input !== undefined ? <ToolInput input={part.input} /> : null}
        {'output' in part || 'errorText' in part ? (
          <ToolOutput
            output={'output' in part ? part.output : undefined}
            errorText={'errorText' in part ? part.errorText : undefined}
          />
        ) : null}
      </ToolContent>
    </Tool>
  );
}

function PlaygroundMessagePart({
  agentId,
  part,
  runStatuses,
}: {
  agentId: string;
  part: PlaygroundUIMessage['parts'][number];
  runStatuses: Record<string, string>;
}) {
  if (part.type === 'data-approval') {
    const { runId } = part.data;
    const status = runStatuses[runId];
    const awaiting = !status || status === 'awaiting_approval';
    const continuing = status === 'queued' || status === 'running';
    return (
      <div className="playground-status" role="status">
        <Clock3 size={16} aria-hidden="true" />
        <span>
          {awaiting
            ? 'Awaiting approval'
            : continuing
              ? 'Resuming after review'
              : 'Review recorded'}
          {' · '}
          {awaiting ? (
            <Link href={`/approvals?agent=${agentId}&run=${runId}`}>Review proposals</Link>
          ) : (
            <Link href={`/agents/${agentId}?run=${runId}#run-${runId}`}>View run</Link>
          )}
        </span>
      </div>
    );
  }
  if (part.type === 'text') return <PlaygroundTextPart text={part.text} />;
  if (part.type === 'reasoning') {
    return <PlaygroundReasoningPart text={part.text} state={part.state} />;
  }
  if (!isToolUIPart(part)) return null;
  if (part.type === 'tool-knowledge.search' && 'output' in part)
    return <KnowledgeToolResult agentId={agentId} output={part.output} />;
  return <PlaygroundToolPart part={part} />;
}

function PlaygroundMessage({
  agentId,
  message,
  runStatuses,
}: {
  agentId: string;
  message: PlaygroundUIMessage;
  runStatuses: Record<string, string>;
}) {
  const parts = message.parts.some((part) => part.type === 'data-approval')
    ? message.parts.filter(
        (part) => part.type !== 'text' || !part.text.startsWith('Simulation queued'),
      )
    : message.parts;
  return (
    <Message from={message.role === 'user' ? 'user' : 'assistant'}>
      <MessageContent>
        {parts.map((part, index) => (
          <PlaygroundMessagePart
            key={`${message.id}-part-${index}`}
            agentId={agentId}
            part={part}
            runStatuses={runStatuses}
          />
        ))}
      </MessageContent>
    </Message>
  );
}
