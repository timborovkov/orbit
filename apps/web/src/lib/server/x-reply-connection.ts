import 'server-only';

import { eq } from 'drizzle-orm';

import { requireAdmin } from '@/lib/auth';
import { db } from '@/lib/db';
import { lockApprovalAgent } from '@/lib/runtime/approval-work';
import { encryptSecret } from '@/lib/runtime/secrets';
import { xReplySecretSubject } from '@/lib/runtime/x/reply';
import { identifyXReplyAccount } from '@/lib/runtime/x/reply-provider';
import { audit, xReplyCredentials } from '@/lib/schema';

export async function getXReplyConnection(agentId: string) {
  await requireAdmin();
  const [connection] = await db()
    .select({ username: xReplyCredentials.username })
    .from(xReplyCredentials)
    .where(eq(xReplyCredentials.agentId, agentId));
  return connection ?? null;
}

export async function connectXReplyAccount(actor: string, agentId: string, token: string) {
  let encryptedToken: string;
  try {
    encryptedToken = encryptSecret(xReplySecretSubject(agentId), token);
  } catch {
    return { error: 'Configure credential encryption before connecting an X account.' };
  }
  const { account, error } = await identifyXReplyAccount(token);
  if (!account) return { error };
  try {
    return await db().transaction(async (tx) => {
      const agent = await lockApprovalAgent(tx, agentId);
      if (!agent) return { error: 'Agent not found.' };
      const values = { userId: account.id, username: account.username, encryptedToken };
      await tx
        .insert(xReplyCredentials)
        .values({ agentId, ...values })
        .onConflictDoUpdate({ target: xReplyCredentials.agentId, set: values });
      await tx.insert(audit).values({ actor, action: `Connected an X account for ${agent.name}` });
      return { message: 'X account connected.' };
    });
  } catch {
    return {
      error: 'The X connection could not be saved. Each X account can be connected to one agent.',
    };
  }
}

export async function disconnectXReplyAccount(actor: string, agentId: string) {
  return db().transaction(async (tx) => {
    const agent = await lockApprovalAgent(tx, agentId);
    if (!agent) return { error: 'Agent not found.' };
    await tx.delete(xReplyCredentials).where(eq(xReplyCredentials.agentId, agentId));
    await tx
      .insert(audit)
      .values({ actor, action: `Disconnected the X account for ${agent.name}` });
    return { message: 'X account disconnected.' };
  });
}
