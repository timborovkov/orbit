import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { requireAdmin } from '@/lib/auth';
import { db } from '@/lib/db';
import { agents } from '@/lib/schema';
import { getPicture } from '@/lib/storage/objects';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return new Response(null, { status: 404 });
  const agent = (
    await db().select({ key: agents.pictureKey }).from(agents).where(eq(agents.id, id))
  ).at(0);
  if (!agent?.key) return new Response(null, { status: 404 });
  try {
    const bytes = await getPicture(agent.key);
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
