'use client';

import { useState } from 'react';
import Image from 'next/image';

export function AgentAvatar({
  id,
  name,
  pictureKey,
  className = 'avatar',
}: {
  id: string;
  name: string;
  pictureKey: string | null;
  className?: string;
}) {
  const [failedKey, setFailedKey] = useState<string | null>(null);
  return (
    <span className={`${className} agent-picture`}>
      {pictureKey && failedKey !== pictureKey ? (
        <Image
          src={`/agents/${id}/picture?v=${encodeURIComponent(pictureKey)}`}
          alt={`${name} profile picture`}
          fill
          sizes="64px"
          unoptimized
          onError={() => {
            setFailedKey(pictureKey);
          }}
        />
      ) : (
        <span aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
      )}
    </span>
  );
}
