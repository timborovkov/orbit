'use client';

import {
  useCallback,
  useMemo,
  useState,
  type ComponentProps,
  type HTMLAttributes,
  type ReactElement,
} from 'react';
import type { UIMessage } from 'ai';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';

import {
  MessageBranchContext,
  useMessageBranch,
  type MessageBranchContextType,
} from '@/components/ai-elements/message-branch-context';
import { Button } from '@/components/ui/button';
import { ButtonGroup, ButtonGroupText } from '@/components/ui/button-group';
import { cn } from '@/lib/utils';

type MessageBranchProps = HTMLAttributes<HTMLDivElement> & {
  defaultBranch?: number;
  onBranchChange?: (branchIndex: number) => void;
};

export function MessageBranch({
  defaultBranch = 0,
  onBranchChange,
  className,
  ...props
}: MessageBranchProps) {
  const [currentBranch, setCurrentBranch] = useState(defaultBranch);
  const [branches, setBranches] = useState<ReactElement[]>([]);

  const goToPrevious = useCallback(() => {
    const newBranch = currentBranch > 0 ? currentBranch - 1 : branches.length - 1;
    setCurrentBranch(newBranch);
    onBranchChange?.(newBranch);
  }, [branches.length, currentBranch, onBranchChange]);

  const goToNext = useCallback(() => {
    const newBranch = currentBranch < branches.length - 1 ? currentBranch + 1 : 0;
    setCurrentBranch(newBranch);
    onBranchChange?.(newBranch);
  }, [branches.length, currentBranch, onBranchChange]);

  const contextValue = useMemo<MessageBranchContextType>(
    () => ({
      currentBranch,
      totalBranches: branches.length,
      goToPrevious,
      goToNext,
      branches,
      setBranches,
    }),
    [currentBranch, branches, goToPrevious, goToNext, setBranches],
  );

  return (
    <MessageBranchContext.Provider value={contextValue}>
      <div className={cn('grid w-full gap-2 [&>div]:pb-0', className)} {...props} />
    </MessageBranchContext.Provider>
  );
}

type MessageBranchSelectorProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage['role'];
};

export function MessageBranchSelector({
  className: _className,
  from: _from,
  ...props
}: MessageBranchSelectorProps) {
  const { totalBranches } = useMessageBranch();

  if (totalBranches <= 1) {
    return null;
  }

  return (
    <ButtonGroup
      className="[&>*:not(:first-child)]:rounded-l-md [&>*:not(:last-child)]:rounded-r-md"
      orientation="horizontal"
      {...props}
    />
  );
}

type MessageBranchPreviousProps = ComponentProps<typeof Button>;

export function MessageBranchPrevious({ children, ...props }: MessageBranchPreviousProps) {
  const { goToPrevious, totalBranches } = useMessageBranch();

  return (
    <Button
      aria-label="Previous branch"
      disabled={totalBranches <= 1}
      onClick={goToPrevious}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronLeftIcon size={14} />}
    </Button>
  );
}

type MessageBranchNextProps = ComponentProps<typeof Button>;

export function MessageBranchNext({
  children,
  className: _className,
  ...props
}: MessageBranchNextProps) {
  const { goToNext, totalBranches } = useMessageBranch();

  return (
    <Button
      aria-label="Next branch"
      disabled={totalBranches <= 1}
      onClick={goToNext}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronRightIcon size={14} />}
    </Button>
  );
}

type MessageBranchPageProps = HTMLAttributes<HTMLSpanElement>;

export function MessageBranchPage({ className, ...props }: MessageBranchPageProps) {
  const { currentBranch, totalBranches } = useMessageBranch();

  return (
    <ButtonGroupText
      className={cn('border-none bg-transparent text-muted-foreground shadow-none', className)}
      {...props}
    >
      {currentBranch + 1} of {totalBranches}
    </ButtonGroupText>
  );
}
