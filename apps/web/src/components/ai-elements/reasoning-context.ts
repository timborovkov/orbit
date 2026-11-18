'use client';

import { createContext } from 'react';

export interface ReasoningContextValue {
  isStreaming: boolean;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  duration: number | undefined;
}

export const ReasoningContext = createContext<ReasoningContextValue | null>(null);