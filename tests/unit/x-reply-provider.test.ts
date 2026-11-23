import { expect, mock, test } from 'bun:test';

import { deliverXReply, identifyXReplyAccount } from '@/lib/runtime/x/reply-provider';

const token = 'fixture-x-user-token';
const payload = {
  token,
  userId: '100',
  authorId: '200',
  postId: '300',
  text: 'Happy to explain.',
  signal: new AbortController().signal,
};

function response(data: unknown, status = 200) {
  return Response.json(data, { status });
}

function transport(...responses: Response[]) {
  const calls = mock((_url: Parameters<typeof fetch>[0], _init?: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error('Unexpected provider call');
    return Promise.resolve(next);
  });
  return { calls, fetchImpl: Object.assign(calls, { preconnect: fetch.preconnect }) };
}

test('X lookup verifies the user token and stores no provider error body', async () => {
  const { fetchImpl, calls } = transport(
    response({ data: { id: '100', username: 'fixture_user' } }),
    response({ detail: 'sensitive example' }, 403),
  );
  expect(await identifyXReplyAccount(token, fetchImpl)).toEqual({
    account: { id: '100', username: 'fixture_user' },
  });
  expect(await identifyXReplyAccount(token, fetchImpl)).toMatchObject({
    error: expect.stringContaining('403'),
  });
  expect(calls.mock.calls[0]?.[0]).toBe('https://api.x.com/2/users/me');
});

test.each([
  { data: { id: '300', author_id: '200', entities: { mentions: [{ id: '100' }] } } },
  {
    data: { id: '300', author_id: '200', referenced_tweets: [{ type: 'quoted', id: '400' }] },
    includes: { tweets: [{ id: '400', author_id: '100' }] },
  },
])('X replies use the verified source post, user token and AI disclosure', async (post) => {
  const { fetchImpl, calls } = transport(response(post), response({ data: { id: '900' } }, 201));
  expect(await deliverXReply({ ...payload, fetchImpl })).toEqual({
    ok: true,
    id: '900',
    raw: { status: 201 },
  });
  const [url, init] = calls.mock.calls[1]!;
  expect(url).toBe('https://api.x.com/2/tweets');
  expect(init?.method).toBe('POST');
  expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
  expect(JSON.parse(String(init?.body))).toEqual({
    text: payload.text,
    reply: { in_reply_to_tweet_id: '300' },
    made_with_ai: true,
  });
});

test('X refuses to post when the original author did not summon this account', async () => {
  const { fetchImpl, calls } = transport(
    response({
      data: { id: '300', author_id: '200', entities: { mentions: [{ id: '999' }] } },
    }),
  );
  expect(await deliverXReply({ ...payload, fetchImpl })).toMatchObject({
    ok: false,
    retryable: false,
  });
  expect(calls).toHaveBeenCalledTimes(1);
});

test('X rate limits can retry while an ambiguous write never yields a retryable result', async () => {
  const post = { data: { id: '300', author_id: '200', entities: { mentions: [{ id: '100' }] } } };
  const limited = transport(response(post), response({}, 429));
  expect(await deliverXReply({ ...payload, fetchImpl: limited.fetchImpl })).toMatchObject({
    ok: false,
    retryable: true,
    raw: { status: 429 },
  });
  const unavailable = transport(response(post), response({}, 503));
  await expect(deliverXReply({ ...payload, fetchImpl: unavailable.fetchImpl })).rejects.toThrow(
    'unconfirmed',
  );
});
