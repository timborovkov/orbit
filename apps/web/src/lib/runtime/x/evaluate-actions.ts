import { proposalTypes } from '@/lib/policy/scopes';

/**
 * X discovery and its evaluation replays share the same grant-dependent action
 * vocabulary. Without the x.reply grant, keep the legacy proposal types so
 * comparisons can still exercise like/repost/reply.
 */
export function xEvaluateActionTypes(
  xChannel: boolean,
  xReplyEnabled: boolean,
  channelProposalTypes: readonly string[] = [],
): readonly string[] {
  if (xChannel && !xReplyEnabled) return proposalTypes;
  return channelProposalTypes;
}
