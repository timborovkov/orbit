'use client';

import { useRef, useState, useTransition } from 'react';

import { savePicture } from '@/actions/pictures';
import { AgentAvatar } from '@/app/agent-avatar';
import { Button } from '@/components/ui/button';

export function ProfilePictureEditor({
  id,
  name,
  pictureKey,
  configured,
}: {
  id: string;
  name: string;
  pictureKey: string | null;
  configured: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ error?: string; message?: string }>({});
  function save(file?: File) {
    if (file && file.size > 5 * 1024 * 1024) {
      setResult({ error: 'Choose a picture smaller than 5 MB.' });
      return;
    }
    const form = new FormData();
    form.set('agentId', id);
    if (file) form.set('picture', file);
    else form.set('remove', 'true');
    startTransition(async () => {
      setResult({});
      try {
        setResult(await savePicture(form));
      } catch {
        setResult({ error: 'Unable to save the picture. Try again.' });
      }
    });
  }
  return (
    <div className="picture-editor">
      <AgentAvatar id={id} name={name} pictureKey={pictureKey} className="picture-preview" />
      <div className="picture-controls">
        <h3>Profile picture</h3>
        <p className="field-hint">JPEG, PNG or WebP, up to 5 MB. Cropped to a square.</p>
        <div className="picture-buttons">
          <Button
            type="button"
            variant="outline"
            disabled={pending || !configured}
            onClick={() => {
              input.current?.click();
            }}
          >
            {pending ? 'Saving…' : pictureKey ? 'Change picture' : 'Upload picture'}
          </Button>
          {pictureKey && (
            <Button
              type="button"
              variant="ghost"
              disabled={pending || !configured}
              onClick={() => {
                save();
              }}
            >
              Remove picture
            </Button>
          )}
        </div>
        <input
          ref={input}
          type="file"
          aria-label="Profile picture"
          accept="image/jpeg,image/png,image/webp"
          hidden
          disabled={pending || !configured}
          onChange={(event) => {
            event.stopPropagation();
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) save(file);
          }}
        />
        {!configured && (
          <p className="field-hint">
            Picture uploads need a RustFS connection. Ask your administrator to configure storage.
          </p>
        )}
        {result.error && (
          <p className="form-error" role="alert">
            {result.error}
          </p>
        )}
        <p className="field-hint" role="status">
          {result.message ?? (pending ? 'Uploading picture…' : '')}
        </p>
      </div>
    </div>
  );
}
