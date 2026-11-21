import { z } from 'zod';

import { getKnowledgeSource } from '@/lib/server/knowledge-queries';
import { getObject } from '@/lib/storage/objects';

const sourceParams = z.object({ id: z.uuid(), documentId: z.uuid() });
const cacheHeaders = { 'Cache-Control': 'private, no-store' };

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; documentId: string }> },
) {
  const parsed = sourceParams.safeParse(await params);
  if (!parsed.success) return new Response(null, { status: 404, headers: cacheHeaders });
  const source = await getKnowledgeSource(parsed.data.id, parsed.data.documentId);
  if (!source) return new Response(null, { status: 404, headers: cacheHeaders });

  try {
    const original = await getObject(source.objectKey);
    if (!original) return new Response(null, { status: 404, headers: cacheHeaders });
    const filename = encodeURIComponent(source.filename).replace(
      /['()*]/g,
      (char) => `%${char.charCodeAt(0).toString(16)}`,
    );
    return new Response(Buffer.from(original.body), {
      headers: {
        ...cacheHeaders,
        'Content-Type': source.mimeType,
        'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'NoSuchKey') {
      return new Response(null, { status: 404, headers: cacheHeaders });
    }
    return new Response(null, { status: 503, headers: cacheHeaders });
  }
}
