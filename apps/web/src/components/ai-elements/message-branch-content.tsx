'use client';

import { Children, isValidElement, useMemo, type HTMLAttributes, type ReactElement } from 'react';

import { cn } from '@/lib/utils';

import { useMessageBranch } from './message-branch-context';

type MessageBranchContentProps = HTMLAttributes<HTMLDivElement>;

export function MessageBranchContent({ children, ...props }: MessageBranchContentProps) {
  const { currentBranch, setBranches, branches } = useMessageBranch();
  const childrenArray = useMemo(
    () =>
      Children.toArray(children).filter((child): child is ReactElement => isValidElement(child)),
    [children],
  );
  const childSignature = childrenArray.map((child) => String(child.key)).join('\0');
  const branchSignature = branches.map((child) => String(child.key)).join('\0');

  if (childSignature !== branchSignature) {
    setBranches(childrenArray);
  }

  return childrenArray.map((branch, index) => (
    <div
      className={cn(
        'grid gap-2 overflow-hidden [&>div]:pb-0',
        index === currentBranch ? 'block' : 'hidden',
      )}
      key={branch.key}
      {...props}
    >
      {branch}
    </div>
  ));
}