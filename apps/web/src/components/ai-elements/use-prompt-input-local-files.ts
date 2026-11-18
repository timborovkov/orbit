'use client';

import { useCallback, useState } from 'react';
import type { FileUIPart } from 'ai';
import { nanoid } from 'nanoid';

import { readFileAsDataUrl } from './file-data-url';

interface PromptInputError {
  code: 'max_files' | 'max_file_size' | 'accept';
  message: string;
}

export function usePromptInputLocalFiles(options: {
  accept?: string;
  maxFiles?: number;
  maxFileSize?: number;
  onError?: (err: PromptInputError) => void;
}) {
  const { accept, maxFiles, maxFileSize, onError } = options;
  const [items, setItems] = useState<(FileUIPart & { id: string })[]>([]);

  const matchesAccept = useCallback(
    (f: File) => {
      if (!accept || accept.trim() === '') {
        return true;
      }

      const patterns = accept
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      return patterns.some((pattern) => {
        if (pattern.endsWith('/*')) {
          const prefix = pattern.slice(0, -1);
          return f.type.startsWith(prefix);
        }
        return f.type === pattern;
      });
    },
    [accept],
  );

  const addLocal = useCallback(
    async (fileList: File[] | FileList) => {
      const incoming = Array.from(fileList);
      const accepted = incoming.filter((f) => matchesAccept(f));
      if (incoming.length && accepted.length === 0) {
        onError?.({
          code: 'accept',
          message: 'No files match the accepted types.',
        });
        return;
      }
      const withinSize = (f: File) => (maxFileSize ? f.size <= maxFileSize : true);
      const sized = accepted.filter(withinSize);
      if (accepted.length > 0 && sized.length === 0) {
        onError?.({
          code: 'max_file_size',
          message: 'All files exceed the maximum size.',
        });
        return;
      }

      const capacity =
        typeof maxFiles === 'number' ? Math.max(0, maxFiles - items.length) : undefined;
      const capped = typeof capacity === 'number' ? sized.slice(0, capacity) : sized;
      const tooMany = typeof capacity === 'number' && sized.length > capacity;

      const next = await Promise.all(
        capped.map(async (file) => ({
          id: nanoid(),
          type: 'file' as const,
          url: await readFileAsDataUrl(file),
          mediaType: file.type,
          filename: file.name,
        })),
      );
      setItems((prev) => prev.concat(next));

      if (tooMany) {
        onError?.({
          code: 'max_files',
          message: 'Too many files. Some were not added.',
        });
      }
    },
    [items.length, matchesAccept, maxFiles, maxFileSize, onError],
  );

  const removeLocal = useCallback((id: string) => {
    setItems((prev) => prev.filter((file) => file.id !== id));
  }, []);

  const clearLocal = useCallback(() => {
    setItems([]);
  }, []);

  return { items, setItems, addLocal, removeLocal, clearLocal };
}

export async function convertBlobUrlToDataUrl(url: string): Promise<string | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }
    const blob = await response.blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        resolve(reader.result as string);
      };
      reader.onerror = () => {
        resolve(null);
      };
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}