'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, isToolUIPart, type ChatStatus, type UIMessage } from 'ai';
import {
  ArrowUp,
  ChevronDown,
  Eraser,
  FlaskConical,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';

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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
  const [recipientsOpen, setRecipientsOpen] = useState(false);
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
      <div className="editor-section-heading playground-chat-heading">
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

      <div className="playground-toolbar">
        <Field className="playground-version-field gap-2">
          <FieldLabel htmlFor="run-version">Configuration version</FieldLabel>
          <Select value={configurationId} onValueChange={setConfigurationOverride}>
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
                  Version {version.version} · {version.config.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription>Paid model inference runs on the Bun worker.</FieldDescription>
        </Field>

        <Collapsible
          open={recipientsOpen}
          onOpenChange={setRecipientsOpen}
          className="playground-recipients"
        >
          <CollapsibleTrigger asChild>
            <Button type="button" variant="outline" className="playground-recipients-trigger">
              Recipients for consent checks
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
        <PlaygroundConversation messages={messages} status={status} />

        <div className="playground-composer">
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
                className="resize-none border-0 bg-transparent shadow-none focus-visible:border-0 focus-visible:ring-0"
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
                <PromptInputSubmit
                  type="button"
                  status={status}
                  aria-label="Stop"
                  size="icon-sm"
                  className="playground-submit"
                  onClick={() => {
                    void stop();
                  }}
                />
              ) : (
                <PromptInputSubmit
                  disabled={!canSimulate || busy}
                  status={status}
                  size="icon-sm"
                  className="playground-submit"
                >
                  <ArrowUp className="size-4" aria-hidden="true" />
                </PromptInputSubmit>
              )}
            </PromptInputFooter>
          </PromptInput>

          {(formError ?? error) && (
            <p role="alert" className="form-error">
              {formError ?? error?.message ?? 'Unable to run simulation.'}
            </p>
          )}
        </div>
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
        {!messages.length && status === 'ready' && (
          <ConversationEmptyState
            icon={<FlaskConical size={30} strokeWidth={1.25} aria-hidden="true" />}
            title="A safe place to try things"
            description="Paste an input and send. Evaluation, proposed actions and drafts stream here while the worker runs the simulation."
          />
        )}
        {messages.map((message) => (
          <PlaygroundMessage key={message.id} message={message} />
        ))}
        {status === 'submitted' && (
          <Message from="assistant">
            <MessageContent>
              <div className="playground-status" role="status">
                <Loader />
                <span>Queueing simulation…</span>
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
  part: Extract<UIMessage['parts'][number], { type: `tool-${string}` } | { type: 'dynamic-tool' }>;
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
  part,
}: {
  messageId: string;
  part: UIMessage['parts'][number];
  index: number;
}) {
  if (part.type === 'text') return <PlaygroundTextPart text={part.text} />;
  if (part.type === 'reasoning') {
    return <PlaygroundReasoningPart text={part.text} state={part.state} />;
  }
  if (!isToolUIPart(part)) return null;
  return <PlaygroundToolPart part={part} />;
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
