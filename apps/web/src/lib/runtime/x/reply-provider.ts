import { z } from 'zod';

import { xPostId } from '@/lib/runtime/x/reply-input';

const api = 'https://api.x.com/2/';
const identity = z.object({
  id: xPostId,
  username: z.string().regex(/^[a-z0-9_]{1,15}$/i),
});
const postLookup = z.object({
  data: z.object({
    id: xPostId,
    author_id: xPostId,
    entities: z
      .object({ mentions: z.array(z.object({ id: xPostId.optional() })).optional() })
      .optional(),
    referenced_tweets: z.array(z.object({ type: z.string(), id: xPostId })).optional(),
  }),
  includes: z
    .object({
      tweets: z.array(z.object({ id: xPostId, author_id: xPostId.optional() })).optional(),
    })
    .optional(),
});
const sent = z.object({ data: z.object({ id: xPostId }) });

function headers(token: string) {
  return { Authorization: `Bearer ${token}`, Accept: 'application/json' };
}

export async function identifyXReplyAccount(token: string, fetchImpl: typeof fetch = fetch) {
  try {
    const response = await fetchImpl(api + 'users/me', {
      headers: headers(token),
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok)
      return { error: `X could not verify this user token (HTTP ${response.status}).` };
    const parsed = z.object({ data: identity }).safeParse(await response.json());
    if (parsed.success) return { account: parsed.data.data };
  } catch {
    return { error: 'X user lookup failed. Try again.' };
  }
  return { error: 'X user lookup returned an invalid account.' };
}

export async function deliverXReply({
  token,
  userId,
  authorId,
  postId,
  text,
  signal,
  fetchImpl = fetch,
}: {
  token: string;
  userId: string;
  authorId: string;
  postId: string;
  text: string;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}) {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  const url = new URL(api + 'tweets/' + xPostId.parse(postId));
  url.searchParams.set('tweet.fields', 'author_id,entities,referenced_tweets');
  url.searchParams.set('expansions', 'referenced_tweets.id');
  let lookup: Response;
  try {
    lookup = await fetchImpl(url, { headers: headers(token), redirect: 'error', signal: bounded });
  } catch {
    return { ok: false, retryable: true, error: 'X post lookup failed before delivery.' } as const;
  }
  if (!lookup.ok) {
    return {
      ok: false,
      retryable: lookup.status === 429 || lookup.status >= 500,
      error: `X post lookup failed (HTTP ${lookup.status}).`,
    } as const;
  }
  const result = postLookup.safeParse(await lookup.json().catch(() => null));
  const post = result.success ? result.data.data : null;
  const quoted = post?.referenced_tweets?.find(({ type }) => type === 'quoted');
  const summoned =
    post?.entities?.mentions?.some(({ id }) => id === userId) ||
    (quoted &&
      result.success &&
      result.data.includes?.tweets?.some(
        (tweet) => tweet.id === quoted.id && tweet.author_id === userId,
      ));
  if (
    !post ||
    post.id !== postId ||
    post.author_id !== authorId ||
    authorId === userId ||
    !summoned
  ) {
    return {
      ok: false,
      retryable: false,
      error: 'X requires the original author to mention this account or quote one of its posts.',
    } as const;
  }
  if (bounded.aborted) {
    return { ok: false, retryable: true, error: 'X reply stopped before delivery.' } as const;
  }
  // A thrown request or an invalid success response leaves the creation outcome unknown.
  const response = await fetchImpl(api + 'tweets', {
    method: 'POST',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    redirect: 'error',
    body: JSON.stringify({ text, reply: { in_reply_to_tweet_id: postId }, made_with_ai: true }),
    signal: bounded,
  });
  if (response.status >= 500) throw new Error('X reply outcome unconfirmed.');
  if (!response.ok) {
    return {
      ok: false,
      retryable: response.status === 429,
      error: `X rejected the reply (HTTP ${response.status}).`,
      raw: { status: response.status },
    } as const;
  }
  const parsed = sent.parse(await response.json());
  return { ok: true, id: parsed.data.id, raw: { status: response.status } } as const;
}
