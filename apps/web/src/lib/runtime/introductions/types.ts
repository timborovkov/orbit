import { z } from 'zod';

export const PEOPLE_SEARCH = 'people.search';
export const PEOPLE_INTRODUCE = 'people.introduce';
export const INTRODUCTION_REVIEW = 'people.introduction.review';

export const peopleGrants = [
  {
    type: PEOPLE_SEARCH,
    label: 'People search',
    description: 'Find display names for people this agent has interacted with.',
  },
  {
    type: PEOPLE_INTRODUCE,
    label: 'Introduction proposals',
    description: 'Propose matches for independent consent and administrator review.',
  },
] as const;

export const peopleGrant = z.enum([PEOPLE_SEARCH, PEOPLE_INTRODUCE]);
export type PeopleGrant = z.infer<typeof peopleGrant>;

export const introductionDecision = z.enum(['agreed', 'declined', 'revoked']);
export type IntroductionDecision = z.infer<typeof introductionDecision>;

const blurb = z
  .string()
  .trim()
  .min(1)
  .max(280)
  .refine(
    (value) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}@<>]|https?:\/\/|www\.|(?:\d[ .()+-]*){7}/iu.test(value),
    'Use one line of match context without contact details.',
  );

const partyInput = z.object({ personId: z.uuid(), blurb });

export const introductionInput = z
  .object({
    first: partyInput,
    second: partyInput,
    rationale: z.string().trim().min(1).max(500),
  })
  .refine(({ first, second }) => first.personId !== second.personId, {
    message: 'Choose two distinct people.',
  });

export type IntroductionDisclosure = {
  identityId: string;
  identityRevision: number;
  sourceKind: 'email' | 'event';
  sourceId: string;
  name: string;
  blurb: string;
};
