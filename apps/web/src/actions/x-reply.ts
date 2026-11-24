'use server';

import { revalidatePath } from 'next/cache';

import { z } from 'zod';

import { checkOrigin, requireAdmin } from '@/lib/auth';
import { xUserAccessToken } from '@/lib/runtime/x/reply-input';
import { connectXReplyAccount, disconnectXReplyAccount } from '@/lib/server/x-reply-connection';

export async function saveXReplyConnection(form: FormData) {
  await checkOrigin();
  const actor = await requireAdmin();
  const agentId = z.uuid().safeParse(form.get('agentId'));
  if (!agentId.success) return { error: 'Choose a valid agent.' };
  if (form.get('disconnect') === 'true') {
    const result = await disconnectXReplyAccount(actor, agentId.data);
    revalidatePath(`/agents/${agentId.data}`);
    return result;
  }
  const token = xUserAccessToken.safeParse(form.get('token'));
  if (!token.success) return { error: 'Enter an X user access token.' };
  if (form.get('platformApproval') !== 'on') {
    return { error: 'Confirm X has approved this account for AI replies.' };
  }
  const result = await connectXReplyAccount(actor, agentId.data, token.data);
  revalidatePath(`/agents/${agentId.data}`);
  return result;
}
