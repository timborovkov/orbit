'use client';

import { useRef, type ComponentProps, type HTMLAttributes } from 'react';

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@/components/ui/input-group';
import { cn } from '@/lib/utils';

type PromptInputProps = Omit<ComponentProps<'form'>, 'action' | 'onSubmit'> & {
  onSubmit: (text: string) => void;
  onAttachment: () => void;
};

export function PromptInput({
  children,
  className,
  onSubmit,
  onAttachment,
  ...props
}: PromptInputProps) {
  return (
    <form
      className={cn('w-full', className)}
      action={(form) => {
        const text = form.get('message');
        if (typeof text === 'string') onSubmit(text);
      }}
      {...props}
    >
      <InputGroup
        className="overflow-hidden"
        onPaste={(event) => {
          if (!Array.from(event.clipboardData.items).some((item) => item.kind === 'file')) return;
          event.preventDefault();
          onAttachment();
        }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) event.preventDefault();
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          onAttachment();
        }}
      >
        {children}
      </InputGroup>
    </form>
  );
}

export function PromptInputTextarea({
  className,
  ...props
}: ComponentProps<typeof InputGroupTextarea>) {
  const composing = useRef(false);

  return (
    <InputGroupTextarea
      className={cn('field-sizing-content max-h-48 min-h-16', className)}
      name="message"
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
      }}
      onKeyDown={(event) => {
        if (
          event.key !== 'Enter' ||
          event.shiftKey ||
          composing.current ||
          event.nativeEvent.isComposing
        ) {
          return;
        }
        event.preventDefault();
        const form = event.currentTarget.form;
        const button = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
        if (button && !button.disabled) form?.requestSubmit(button);
      }}
      {...props}
    />
  );
}

export function PromptInputFooter({
  className,
  ...props
}: Omit<ComponentProps<typeof InputGroupAddon>, 'align'>) {
  return (
    <InputGroupAddon
      align="block-end"
      className={cn('justify-between gap-1', className)}
      {...props}
    />
  );
}

export function PromptInputTools({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex items-center gap-1', className)} {...props} />;
}

export function PromptInputSubmit(props: ComponentProps<typeof InputGroupButton>) {
  return <InputGroupButton aria-label="Submit" type="submit" variant="default" {...props} />;
}
