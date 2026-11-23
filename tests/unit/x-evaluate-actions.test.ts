import { expect, test } from 'bun:test';

import { proposalTypes } from '@/lib/policy/scopes';
import { xEvaluateActionTypes } from '@/lib/runtime/x/evaluate-actions';
import { X_REPLY_ACTION } from '@/lib/runtime/x/reply-input';

test('X evaluate without the reply grant keeps the legacy discovery vocabulary', () => {
  expect(xEvaluateActionTypes(true, false, [X_REPLY_ACTION])).toEqual(proposalTypes);
  expect(xEvaluateActionTypes(true, false, [X_REPLY_ACTION])).toContain('like');
  expect(xEvaluateActionTypes(true, false, [X_REPLY_ACTION])).toContain('repost');
  expect(xEvaluateActionTypes(true, false, [X_REPLY_ACTION])).toContain('reply');
});

test('X evaluate with the reply grant uses the channel proposal types', () => {
  expect(xEvaluateActionTypes(true, true, [X_REPLY_ACTION])).toEqual([X_REPLY_ACTION]);
});

test('non-X evaluate channels keep their own proposal types', () => {
  expect(xEvaluateActionTypes(false, false, ['fixture.reply'])).toEqual(['fixture.reply']);
  expect(xEvaluateActionTypes(false, true, ['fixture.reply'])).toEqual(['fixture.reply']);
});
