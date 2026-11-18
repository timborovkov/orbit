'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ChangeEventHandler,
  type HTMLAttributes,
  type RefObject,
  type SubmitEventHandler,
  type SyntheticEvent,
} from 'react';
import type { FileUIPart } from 'ai';

import { LocalAttachmentsContext } from '@/components/ai-elements/prompt-input-local-context';
import {
  useOptionalPromptInputController,
  type AttachmentsContext,
} from '@/components/ai-elements/prompt-input-provider';
import type { PromptInputMessage } from '@/components/ai-elements/prompt-input-types';
import {
  convertBlobUrlToDataUrl,
  usePromptInputLocalFiles,
} from '@/components/ai-elements/use-prompt-input-local-files';
import { InputGroup } from '@/components/ui/input-group';
import { cn } from '@/lib/utils';

export type PromptInputFormProps = Omit<HTMLAttributes<HTMLFormElement>, 'onSubmit' | 'onError'> & {
  accept?: string;
  multiple?: boolean;
  globalDrop?: boolean;
  syncHiddenInput?: boolean;
  maxFiles?: number;
  maxFileSize?: number;
  onError?: (err: { code: 'max_files' | 'max_file_size' | 'accept'; message: string }) => void;
  onSubmit: (
    message: PromptInputMessage,
    event: SyntheticEvent<HTMLFormElement>,
  ) => void | Promise<void>;
};

function usePromptInputDropTargets(
  add: (files: File[] | FileList) => void,
  formRef: RefObject<HTMLFormElement | null>,
  globalDrop?: boolean,
) {
  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    if (globalDrop) return;

    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
      }
    };
    const onDrop = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
      }
      if (e.dataTransfer && e.dataTransfer.files.length > 0) {
        add(e.dataTransfer.files);
      }
    };
    form.addEventListener('dragover', onDragOver);
    form.addEventListener('drop', onDrop);
    return () => {
      form.removeEventListener('dragover', onDragOver);
      form.removeEventListener('drop', onDrop);
    };
  }, [add, globalDrop, formRef]);

  useEffect(() => {
    if (!globalDrop) return;

    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
      }
    };
    const onDrop = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
      }
      if (e.dataTransfer && e.dataTransfer.files.length > 0) {
        add(e.dataTransfer.files);
      }
    };
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('drop', onDrop);
    return () => {
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('drop', onDrop);
    };
  }, [add, globalDrop]);
}

export function PromptInputForm({
  className,
  accept,
  multiple,
  globalDrop,
  syncHiddenInput,
  maxFiles,
  maxFileSize,
  onError,
  onSubmit,
  children,
  ...props
}: PromptInputFormProps) {
  const controller = useOptionalPromptInputController();
  const usingProvider = !!controller;

  const inputRef = useRef<HTMLInputElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);

  const { items, addLocal, removeLocal, clearLocal } = usePromptInputLocalFiles({
    accept,
    maxFiles,
    maxFileSize,
    onError,
  });
  const files = usingProvider ? controller.attachments.files : items;

  const filesRef = useRef(files);
  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  const openFileDialogLocal = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const add = usingProvider ? controller.attachments.add : addLocal;
  const remove = usingProvider ? controller.attachments.remove : removeLocal;
  const clear = usingProvider ? controller.attachments.clear : clearLocal;
  const openFileDialog = usingProvider
    ? controller.attachments.openFileDialog
    : openFileDialogLocal;

  useEffect(() => {
    if (!usingProvider) return;
    controller.__registerFileInput(inputRef, () => inputRef.current?.click());
  }, [usingProvider, controller]);

  useEffect(() => {
    if (syncHiddenInput && inputRef.current && files.length === 0) {
      inputRef.current.value = '';
    }
  }, [files, syncHiddenInput]);

  usePromptInputDropTargets(add, formRef, globalDrop);

  const handleChange: ChangeEventHandler<HTMLInputElement> = (event) => {
    if (event.currentTarget.files) {
      add(event.currentTarget.files);
    }
    event.currentTarget.value = '';
  };

  const ctx = useMemo<AttachmentsContext>(
    () => ({
      files: files.map((item) => ({ ...item, id: item.id })),
      add,
      remove,
      clear,
      openFileDialog,
      fileInputRef: inputRef,
    }),
    [files, add, remove, clear, openFileDialog],
  );

  const handleSubmit: SubmitEventHandler<HTMLFormElement> = (event) => {
    event.preventDefault();

    const form = event.currentTarget;
    const text = usingProvider
      ? controller.textInput.value
      : (() => {
          const formData = new FormData(form);
          return (formData.get('message') as string) || '';
        })();

    if (!usingProvider) {
      form.reset();
    }

    void Promise.all(
      files.map(async ({ id: _id, ...item }) => {
        if (item.url.startsWith('blob:')) {
          const dataUrl = await convertBlobUrlToDataUrl(item.url);
          return {
            ...item,
            url: dataUrl ?? item.url,
          };
        }
        return item;
      }),
    )
      .then((convertedFiles: FileUIPart[]) => {
        try {
          const result = onSubmit({ text, files: convertedFiles }, event);

          if (result instanceof Promise) {
            result
              .then(() => {
                clear();
                if (usingProvider) {
                  controller.textInput.clear();
                }
              })
              .catch(() => {
                void 0;
              });
          } else {
            clear();
            if (usingProvider) {
              controller.textInput.clear();
            }
          }
        } catch {
          // Keep attachments when submit throws
        }
      })
      .catch(() => {
        void 0;
      });
  };

  const inner = (
    <>
      <input
        accept={accept}
        aria-label="Upload files"
        className="sr-only"
        hidden
        multiple={multiple}
        onChange={handleChange}
        ref={inputRef}
        tabIndex={-1}
        title="Upload files"
        type="file"
      />
      <form className={cn('w-full', className)} onSubmit={handleSubmit} ref={formRef} {...props}>
        <InputGroup className="overflow-hidden">{children}</InputGroup>
      </form>
    </>
  );

  return usingProvider ? (
    inner
  ) : (
    <LocalAttachmentsContext.Provider value={ctx}>{inner}</LocalAttachmentsContext.Provider>
  );
}
