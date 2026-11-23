import { createHash } from 'node:crypto';

import { and, eq, gte, inArray, sql } from 'drizzle-orm';

import { db, type Tx } from '@/lib/db';
import { authorizeAction, type CandidateAction, type PolicyContext } from '@/lib/policy/gateway';
import { activeJobClaim, enqueueJob } from '@/lib/queue/jobs';
import type { JobRecord } from '@/lib/queue/types';
import {
  ACTIVE_CRAWL_STATES,
  crawlLimits,
  type CrawlStatus,
  WEB_CRAWL,
  WEB_CRAWL_JOB,
} from '@/lib/research';
import { loadFirecrawlConfig } from '@/lib/runtime/research/connection';
import { saveWebCitations } from '@/lib/runtime/research/evidence';
import { firecrawlClient, FirecrawlError } from '@/lib/runtime/research/firecrawl';
import { parseFirecrawlEnv } from '@/lib/runtime/research/settings';
import {
  crawlAllowed,
  isPublicPage,
  pageWithinScope,
  publicPageUrl,
} from '@/lib/runtime/research/urls';
import { agents, jobs, webCrawls } from '@/lib/schema';

type Crawl = typeof webCrawls.$inferSelect;
const pollIntervalMs = 5_000;
const cleanupGraceMs = 45_000;
const maxStatusRequests = 150;
const timeoutReason = 'The crawl reached its time or polling limit.';
const ambiguousReason =
  'Crawl submission could not be confirmed. Check the provider before starting a new crawl.';

function originHash(origin: string) {
  // A queued job must never be sent to a different instance after a deployment change.
  return createHash('sha256').update(origin).digest('hex');
}

export async function enqueueWebCrawl(
  policy: PolicyContext,
  action: CandidateAction,
  seed: URL,
  pageLimit: number,
  depthLimit: number,
) {
  return db().transaction(async (tx) => {
    const decision = await authorizeAction(policy, action, tx);
    if (decision.decision !== 'allow')
      return { error: decision.reasons.join(' '), policy: decision.decision };
    const [existing] = await tx
      .select({ id: webCrawls.id, status: webCrawls.status })
      .from(webCrawls)
      .where(eq(webCrawls.intentId, decision.intentId));
    if (existing)
      return { crawlId: existing.id, status: existing.status, policy: 'allow' as const };
    if (!decision.created || !policy.runId)
      return { error: 'This crawl request was already processed.', policy: 'allow' as const };

    const [active] = await tx
      .select({ id: webCrawls.id })
      .from(webCrawls)
      .where(
        and(eq(webCrawls.agentId, policy.agentId), inArray(webCrawls.status, ACTIVE_CRAWL_STATES)),
      );
    if (active)
      return { error: 'This agent already has an active crawl.', policy: 'allow' as const };

    const now = new Date();
    const day = new Date(now);
    day.setUTCHours(0, 0, 0, 0);
    const [reserved] = await tx
      .select({ pages: sql<number>`coalesce(sum(${webCrawls.pageLimit}), 0)::int` })
      .from(webCrawls)
      .where(and(eq(webCrawls.agentId, policy.agentId), gte(webCrawls.createdAt, day)));
    if (reserved.pages + pageLimit > crawlLimits.dailyPages)
      return { error: 'This agent reached its daily crawl page limit.', policy: 'allow' as const };

    const { origin } = parseFirecrawlEnv(process.env);
    const [crawl] = await tx
      .insert(webCrawls)
      .values({
        agentId: policy.agentId,
        runId: policy.runId,
        intentId: decision.intentId,
        seedUrl: seed.href,
        originHash: originHash(origin),
        pageLimit,
        depthLimit,
        createdAt: now,
        deadline: new Date(now.getTime() + crawlLimits.deadlineMs),
      })
      .returning({ id: webCrawls.id });
    const job = await enqueueJob(tx, {
      type: WEB_CRAWL_JOB,
      payload: { agentId: policy.agentId, crawlId: crawl.id },
      idempotencyKey: 'web-crawl:' + crawl.id,
    });
    await tx.update(webCrawls).set({ jobId: job.id }).where(eq(webCrawls.id, crawl.id));
    return { crawlId: crawl.id, status: 'queued' as const, policy: 'allow' as const };
  });
}

/** Caller holds the agent lock used by admission and lifecycle changes. */
export async function requestCrawlCancellation(
  tx: Tx,
  agentId: string,
  reason: string,
  crawlId?: string,
) {
  const requestedAt = new Date();
  const filter = and(
    eq(webCrawls.agentId, agentId),
    crawlId ? eq(webCrawls.id, crawlId) : undefined,
    inArray(webCrawls.status, ACTIVE_CRAWL_STATES),
  );
  const queued = await tx
    .update(webCrawls)
    .set({
      status: 'cancelled',
      reason,
      cancelRequestedAt: requestedAt,
      finishedAt: requestedAt,
    })
    .where(and(filter, eq(webCrawls.status, 'queued')))
    .returning({ id: webCrawls.id });
  const pending = await tx
    .update(webCrawls)
    .set({
      status: 'cancelling',
      reason,
      cancelRequestedAt: requestedAt,
    })
    .where(and(filter, inArray(webCrawls.status, ['submitting', 'running'])))
    .returning({ id: webCrawls.id });
  return [...queued, ...pending].length > 0;
}

async function withClaim<T>(
  job: JobRecord,
  workerId: string,
  work: (tx: Tx, crawl: Crawl, agent: typeof agents.$inferSelect) => Promise<T>,
) {
  const { agentId, crawlId } = job.payload;
  if (typeof agentId !== 'string' || typeof crawlId !== 'string' || !job.claimedAt)
    throw new Error('Invalid web crawl job.');
  return db().transaction(async (tx) => {
    const [agent] = await tx.select().from(agents).where(eq(agents.id, agentId)).for('update');
    if (!agent) return;
    const [claim] = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(activeJobClaim(job.id, workerId, job), eq(jobs.type, WEB_CRAWL_JOB)))
      .for('update');
    if (!claim) return;
    const [crawl] = await tx
      .select()
      .from(webCrawls)
      .where(
        and(
          eq(webCrawls.id, crawlId),
          eq(webCrawls.jobId, job.id),
          eq(webCrawls.agentId, agentId),
          inArray(webCrawls.status, ACTIVE_CRAWL_STATES),
        ),
      )
      .for('update');
    if (!crawl) return;
    return work(tx, crawl, agent);
  });
}

async function finish(tx: Tx, crawl: Crawl, status: CrawlStatus, reason: string | null) {
  await tx
    .update(webCrawls)
    .set({ status, reason, finishedAt: new Date() })
    .where(eq(webCrawls.id, crawl.id));
}

async function prepare(tx: Tx, crawl: Crawl, agent: typeof agents.$inferSelect) {
  const seed = publicPageUrl(crawl.seedUrl);
  const allowed =
    seed &&
    (agent.lifecycle === 'shadow' || agent.lifecycle === 'live') &&
    agent.enabledTools.includes(WEB_CRAWL) &&
    crawlAllowed(seed, agent.webCrawlScopes);
  const timedOut =
    Date.now() >= crawl.deadline.getTime() || crawl.pollRequests >= maxStatusRequests;
  const reason =
    crawl.reason ??
    (timedOut ? timeoutReason : 'Crawl access was removed or the agent was paused.');
  const status = crawl.cancelRequestedAt || !allowed || timedOut ? 'cancelling' : crawl.status;

  if (!seed) return finish(tx, crawl, 'failed', 'The saved crawl target is invalid.');
  if (crawl.status === 'queued' && status === 'cancelling') {
    return finish(tx, crawl, timedOut ? 'failed' : 'cancelled', reason);
  }
  if (crawl.status !== 'queued' && !crawl.providerJobId) {
    return finish(tx, crawl, 'failed', ambiguousReason);
  }
  if (status === 'cancelling') {
    const requestedAt = crawl.cancelRequestedAt ?? new Date();
    if (Date.now() >= requestedAt.getTime() + cleanupGraceMs) {
      return finish(
        tx,
        crawl,
        'failed',
        'Firecrawl cancellation could not be confirmed. Check the provider.',
      );
    }
    await tx
      .update(webCrawls)
      .set({ status, reason, cancelRequestedAt: requestedAt })
      .where(eq(webCrawls.id, crawl.id));
    return { crawl, seed, operation: crawl.cancellationSentAt ? 'poll' : 'cancel' } as const;
  }
  if (crawl.status === 'queued') {
    await tx.update(webCrawls).set({ status: 'submitting' }).where(eq(webCrawls.id, crawl.id));
    return { crawl, seed, operation: 'start' } as const;
  }
  await tx
    .update(webCrawls)
    .set({ pollRequests: crawl.pollRequests + 1 })
    .where(eq(webCrawls.id, crawl.id));
  return { crawl, seed, operation: 'poll' } as const;
}

export async function processWebCrawl(
  job: JobRecord,
  workerId: string,
  signal: AbortSignal,
  fetchRequest: typeof fetch = fetch,
) {
  const prepared = await withClaim(job, workerId, prepare);
  if (!prepared) return;
  const { crawl, seed, operation } = prepared;
  let delay: number;
  try {
    const config = await loadFirecrawlConfig(crawl.agentId);
    if (originHash(config.origin) !== crawl.originHash) {
      throw new FirecrawlError(
        'unavailable',
        'The Firecrawl API origin changed. Start a new crawl to rerun it.',
      );
    }
    const client = firecrawlClient(config, fetchRequest);
    if (operation === 'start') {
      if (!(await isPublicPage(seed, signal))) {
        throw new FirecrawlError('rejected', 'The crawl target must resolve to a public address.');
      }
      // Recheck revocation or cancellation after DNS and immediately before the POST.
      const submit = await withClaim(job, workerId, async (tx, current, agent) => {
        const allowed =
          (agent.lifecycle === 'live' || agent.lifecycle === 'shadow') &&
          agent.enabledTools.includes(WEB_CRAWL) &&
          crawlAllowed(seed, agent.webCrawlScopes);
        if (current.status === 'submitting' && allowed) return true;
        await finish(tx, current, 'cancelled', current.reason ?? 'Crawl access was removed.');
        return false;
      });
      if (!submit) return;
      const providerJobId = await client.start(seed, crawl.pageLimit, crawl.depthLimit, signal);
      await withClaim(job, workerId, async (tx, current) => {
        await tx
          .update(webCrawls)
          .set({
            providerJobId,
            status: current.cancelRequestedAt ? 'cancelling' : 'running',
          })
          .where(eq(webCrawls.id, crawl.id));
      });
      delay = 0;
    } else if (operation === 'cancel') {
      await client.cancel(crawl.providerJobId!, signal);
      await withClaim(job, workerId, async (tx) => {
        await tx
          .update(webCrawls)
          .set({ cancellationSentAt: new Date(), cursor: 0 })
          .where(eq(webCrawls.id, crawl.id));
      });
      delay = 0;
    } else {
      const progress = await client.poll(
        crawl.providerJobId!,
        crawl.cursor,
        crawl.pageLimit,
        signal,
      );
      const deferred = await withClaim(job, workerId, async (tx, current) => {
        const pages = progress.pages.filter((page) => {
          const url = publicPageUrl(page.url);
          return url && pageWithinScope(url, seed) && page.rank <= crawl.pageLimit;
        });
        await saveWebCitations(
          tx,
          {
            agentId: crawl.agentId,
            runId: crawl.runId,
            intentId: crawl.intentId,
            crawlId: crawl.id,
            tool: WEB_CRAWL,
          },
          pages,
          crawl.pageLimit,
        );

        const next =
          progress.rawCount && progress.next && progress.next < crawl.pageLimit ? progress.next : 0;
        await tx
          .update(webCrawls)
          .set({
            completedPages: Math.min(
              crawl.pageLimit,
              Math.max(current.completedPages, progress.completed),
            ),
            discoveredPages: Math.min(
              crawl.pageLimit,
              Math.max(current.discoveredPages, progress.total),
            ),
            creditsUsed: progress.creditsUsed ?? current.creditsUsed,
            cursor: next,
          })
          .where(eq(webCrawls.id, crawl.id));

        if (next) return 0;
        if (progress.status === 'failed') {
          await finish(tx, current, 'failed', 'Firecrawl reported that the crawl failed.');
        } else if (progress.status === 'completed') {
          await finish(tx, current, 'completed', null);
        } else if (progress.status === 'cancelled') {
          const expired = current.reason === timeoutReason;
          await finish(tx, current, expired ? 'failed' : 'cancelled', current.reason);
        } else {
          return pollIntervalMs;
        }
      });
      if (deferred === undefined) return;
      delay = deferred;
    }
  } catch (error) {
    signal.throwIfAborted();
    if (!(error instanceof FirecrawlError)) throw error;
    if (operation !== 'start' && error.kind === 'retryable') {
      // The queue retains its retry counter and bounded backoff for transient provider errors.
      throw error;
    }
    await withClaim(job, workerId, async (tx, current) => {
      const ambiguous = operation === 'start' && error.kind === 'retryable';
      await finish(
        tx,
        current,
        error.kind === 'unavailable' ? 'unavailable' : 'failed',
        ambiguous ? ambiguousReason : error.message,
      );
    });
    return;
  }
  signal.throwIfAborted();
  return { deferUntil: new Date(Date.now() + delay) };
}

export async function reconcileDeadWebCrawls() {
  await db().execute(sql`
    UPDATE web_crawls c SET
      status = 'failed',
      reason = CASE
        WHEN c.provider_job_id IS NULL AND c.status IN ('submitting', 'cancelling') THEN ${ambiguousReason}
        WHEN c.cancel_requested_at IS NOT NULL THEN 'Firecrawl cancellation could not be confirmed. Check the provider.'
        ELSE 'The crawl worker exhausted its retries. Check the provider before rerunning.'
      END,
      finished_at = now()
    FROM jobs j
    WHERE c.job_id = j.id AND j.status = 'dead'
      AND c.status IN ('queued','submitting','running','cancelling')
  `);
}
