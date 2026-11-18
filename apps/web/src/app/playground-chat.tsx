'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, isToolUIPart, type ChatStatus, type UIMessage } from 'ai';
import { FlaskConical, ShieldCheck } from 'lucide-react';

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
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
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
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

interface AgentVersion {
  id: string;
  version: number;
  config: { name: string };
}

function lifecycleBlockMessage(lifecycle: string) {
  return lifecycle === 'paused'
    ? 'This agent is paused. Resume it under Access before queueing simulations.'
    : 'This agent is stopped. Change its lifecycle under Access before queueing simulations.';
}

export function PlaygroundChat({
  agentId,
  agentName,
  canSimulate,
  lifecycle,
  versions,
  currentConfigurationId,
}: {
  agentId: string;
  agentName: string;
  canSimulate: boolean;
  lifecycle: string;
  versions: AgentVersion[];
  currentConfigurationId: string;
}) {
  const router = useRouter();
  const [configurationOverride, setConfigurationOverride] = useState<string | null>(null);
  const configurationId = configurationOverride ?? currentConfigurationId;
  const [recipient, setRecipient] = useState('');
  const [otherRecipient, setOtherRecipient] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const bodyRef = useRef({ configurationId, recipient, otherRecipient });
  useEffect(() => {
    bodyRef.current = { configurationId, recipient, otherRecipient };
  }, [configurationId, recipient, otherRecipient]);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: `/api/agents/${agentId}/chat`,
        credentials: 'same-origin',
        prepareSendMessagesRequest: ({ messages }) => {
          const recipients = [bodyRef.current.recipient, bodyRef.current.otherRecipient]
            .map((value) => value.trim())
            .filter(Boolean);
          return {
            body: {
              messages,
              configurationId: bodyRef.current.configurationId,
              recipients,
            },
          };
        },
      }),
    [agentId],
  );

  const { messages, sendMessage, status, stop, error, setMessages } = useChat({
    transport,
    onFinish: () => {
      router.refresh();
    },
  });

  const busy = status === 'submitted' || status === 'streaming';

  async function onSubmit(message: PromptInputMessage) {
    setFormError(null);
    const text = message.text.trim();
    if (!text) {
      setFormError('Paste a post or question with 1–16,000 characters.');
      return;
    }
    if (!canSimulate) {
      setFormError(lifecycleBlockMessage(lifecycle));
      return;
    }
    await sendMessage({ text });
  }

  return (
    <div className="playground-chat">
      <div className="editor-section-heading">
        <h2>Test a conversation</h2>
        <p className="muted">See how {agentName} would respond to a post or question.</p>
      </div>

      {!canSimulate && (
        <div className="run-notice">
          <ShieldCheck size={18} aria-hidden="true" />
          <p>{lifecycleBlockMessage(lifecycle)}</p>
        </div>
      )}

      <div className="playground-chat-shell">
        <PlaygroundConversation messages={messages} status={status} />
        <PlaygroundComposer
          versions={versions}
          configurationId={configurationId}
          onConfigurationIdChange={setConfigurationOverride}
          recipient={recipient}
          otherRecipient={otherRecipient}
          onRecipientChange={setRecipient}
          onOtherRecipientChange={setOtherRecipient}
          canSimulate={canSimulate}
          busy={busy}
          status={status}
          formError={formError}
          chatError={error}
          messageCount={messages.length}
          onSubmit={onSubmit}
          onStop={() => {
            void stop();
          }}
          onClear={() => {
            setMessages([]);
          }}
        />
      </div>
    </div>
  );
}

function PlaygroundConversation({
  messages,
  status,
}: {
  messages: UIMessage[];
  status: ChatStatus;
}) {
  return (
    <Conversation className="playground-conversation">
      <ConversationContent>
        {!messages.length && (
          <ConversationEmptyState
            icon={<FlaskConical size={30} strokeWidth={1.25} aria-hidden="true" />}
            title="A safe place to try things"
            description="Paste an input and send. Evaluation, proposed actions and drafts stream here while the worker runs the simulation."
          />
        )}
        {messages.map((message) => (
          <PlaygroundMessage key={message.id} message={message} />
        ))}
        {status === 'submitted' && <Loader />}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}

function PlaygroundComposer({
  versions,
  configurationId,
  onConfigurationIdChange,
  recipient,
  otherRecipient,
  onRecipientChange,
  onOtherRecipientChange,
  canSimulate,
  busy,
  status,
  formError,
  chatError,
  messageCount,
  onSubmit,
  onStop,
  onClear,
}: {
  versions: AgentVersion[];
  configurationId: string;
  onConfigurationIdChange: (id: string) => void;
  recipient: string;
  otherRecipient: string;
  onRecipientChange: (value: string) => void;
  onOtherRecipientChange: (value: string) => void;
  canSimulate: boolean;
  busy: boolean;
  status: ChatStatus;
  formError: string | null;
  chatError: Error | undefined;
  messageCount: number;
  onSubmit: (message: PromptInputMessage) => Promise<void>;
  onStop: () => void;
  onClear: () => void;
}) {
  return (
    <div className="playground-composer">
      <Field>
        <FieldLabel htmlFor="run-version">Configuration version</FieldLabel>
        <select
          id="run-version"
          aria-label="Configuration version"
          value={configurationId}
          disabled={busy}
          className={cn(
            'h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs outline-none',
            'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 md:text-sm',
          )}
          onChange={(event) => {
            onConfigurationIdChange(event.target.value);
          }}
        >
          {versions.map((version) => (
            <option key={version.id} value={version.id}>
              Version {version.version} · {version.config.name}
            </option>
          ))}
        </select>
        <FieldDescription>Paid model inference runs on the Bun worker.</FieldDescription>
      </Field>

      <details className="policy-recipients">
        <summary>Recipients for consent checks</summary>
        <Field>
          <FieldLabel htmlFor="run-recipient">Recipient ID</FieldLabel>
          <Input
            id="run-recipient"
            name="recipient"
            maxLength={120}
            value={recipient}
            disabled={busy}
            onChange={(event) => {
              onRecipientChange(event.target.value);
            }}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="run-other-recipient">Second recipient ID (introductions)</FieldLabel>
          <Input
            id="run-other-recipient"
            name="otherRecipient"
            maxLength={120}
            value={otherRecipient}
            disabled={busy}
            onChange={(event) => {
              onOtherRecipientChange(event.target.value);
            }}
          />
        </Field>
        <p className="field-hint">Use the same IDs as the consent records in Access.</p>
      </details>

      <PromptInput
        className={cn('playground-prompt', !canSimulate && 'is-disabled')}
        onSubmit={onSubmit}
      >
        <PromptInputBody>
          <PromptInputTextarea
            aria-label="Post or question"
            placeholder="Paste a post or question…"
            disabled={!canSimulate || busy}
            maxLength={16000}
          />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools>
            <p className="simulation-note">
              <ShieldCheck size={15} aria-hidden="true" />
              <span>Nothing is posted or sent. Save your configuration before testing.</span>
            </p>
          </PromptInputTools>
          {status === 'streaming' ? (
            <PromptInputSubmit type="button" status={status} aria-label="Stop" onClick={onStop} />
          ) : (
            <PromptInputSubmit disabled={!canSimulate || busy} status={status} />
          )}
        </PromptInputFooter>
      </PromptInput>

      {(formError ?? chatError) && (
        <p role="alert" className="form-error">
          {formError ?? chatError?.message ?? 'Unable to run simulation.'}
        </p>
      )}

      {messageCount > 0 && (
        <Button
          type="button"
          variant="ghost"
          className="playground-clear"
          onClick={onClear}
          disabled={busy}
        >
          Clear conversation
        </Button>
      )}
    </div>
  );
}

function PlaygroundMessagePart({
  messageId,
  part,
  index,
}: {
  messageId: string;
  part: UIMessage['parts'][number];
  index: number;
}) {
  if (part.type === 'text') {
    return <MessageResponse key={`${messageId}-text-${index}`}>{part.text}</MessageResponse>;
  }
  if (part.type === 'reasoning') {
    return (
      <Reasoning
        key={`${messageId}-reasoning-${index}`}
        isStreaming={part.state === 'streaming'}
        defaultOpen={part.state === 'streaming'}
      >
        <ReasoningTrigger />
        <ReasoningContent>{part.text}</ReasoningContent>
      </Reasoning>
    );
  }
  if (!isToolUIPart(part)) return null;
  const title = part.type.replace(/^tool-/, '');
  const toolType: `tool-${string}` =
    part.type === 'dynamic-tool' ? `tool-${title || 'action'}` : part.type;
  return (
    <Tool key={`${messageId}-tool-${index}`} defaultOpen>
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

function PlaygroundMessage({ message }: { message: UIMessage }) {
  return (
    <Message from={message.role === 'user' ? 'user' : 'assistant'}>
      <MessageContent>
        {message.parts.map((part, index) => (
          <PlaygroundMessagePart
            key={`${message.id}-part-${index}`}
            messageId={message.id}
            part={part}
            index={index}
          />
        ))}
      </MessageContent>
    </Message>
  );
}
