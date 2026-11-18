'use client';

import { memo, type ComponentProps } from 'react';
import { Streamdown } from 'streamdown';

import { cn } from '@/lib/utils';

type MessageResponseProps = ComponentProps<typeof Streamdown>;

const MessageResponseInner = memo(
  ({ className, ...props }: MessageResponseProps) => (
    <Streamdown
      className={cn('size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0', className)}
      {...props}
    />
  ),
  (prevProps, nextProps) => prevProps.children === nextProps.children,
);

MessageResponseInner.displayName = 'MessageResponse';

export function MessageResponse(props: MessageResponseProps) {
  return <MessageResponseInner {...props} />;
}
