'use client';

import { createContext } from 'react';

import type { AttachmentsContext } from './prompt-input-provider';

export const LocalAttachmentsContext = createContext<AttachmentsContext | null>(null);