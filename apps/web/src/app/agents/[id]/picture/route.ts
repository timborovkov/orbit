import { z } from 'zod';

import { requireAdmin } from '@/lib/auth';
import { getAgentPictureKey } from '@/lib/server/workspace-queries';
import { getPicture } from '@/lib/storage/objects';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return new Response(null, { status: 404 });
  const key = await getAgentPictureKey(id);
  if (!key) return new Response(null, { status: 404 });
  try {
    const bytes = await getPicture(key);
    if (!bytes) throw new Error('Missing picture');
    return new Response(Buffer.from(bytes), {
      headers: {
        'Content-Type': 'image/webp',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return new Response(null, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
