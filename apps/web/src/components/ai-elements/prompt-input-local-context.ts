'use client';

import { createContext } from 'react';

import type { AttachmentsContext } from '@/components/ai-elements/prompt-input-provider';

export const LocalAttachmentsContext = createContext<AttachmentsContext | null>(null);
