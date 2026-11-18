'use client';

import { useContext } from 'react';

import { ReasoningContext } from '@/components/ai-elements/reasoning-context';

export const useReasoning = () => {
  const context = useContext(ReasoningContext);
  if (!context) {
    throw new Error('Reasoning components must be used within Reasoning');
  }
  return context;
};