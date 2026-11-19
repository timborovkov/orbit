export interface RankCandidate {
  id: string;
  vectorRank?: number | null;
  textRank?: number | null;
  vectorScore?: number | null;
  textScore?: number | null;
}

export interface MergedRank<T extends RankCandidate> extends RankCandidate {
  source: T;
  rankScore: number;
  reasons: string[];
}

/**
 * Reciprocal Rank Fusion over vector and full-text candidate lists.
 * Candidates present in only one list still receive a contribution from that list.
 */
export function mergeHybridRanks<T extends RankCandidate>(
  vectorHits: T[],
  textHits: T[],
  options: { limit?: number; k?: number } = {},
): MergedRank<T>[] {
  const limit = options.limit ?? 8;
  const k = options.k ?? 60;
  const byId = new Map<string, MergedRank<T>>();

  vectorHits.forEach((hit, index) => {
    const rank = hit.vectorRank ?? index + 1;
    const existing = byId.get(hit.id);
    const contribution = 1 / (k + rank);
    const reasons = [`vector rank #${rank}`];
    if (typeof hit.vectorScore === 'number') {
      reasons.push(`similarity ${hit.vectorScore.toFixed(3)}`);
    }
    if (existing) {
      existing.rankScore += contribution;
      existing.vectorRank = rank;
      existing.vectorScore = hit.vectorScore ?? existing.vectorScore ?? null;
      existing.reasons.push(...reasons);
    } else {
      byId.set(hit.id, {
        ...hit,
        source: hit,
        vectorRank: rank,
        textRank: null,
        vectorScore: hit.vectorScore ?? null,
        textScore: hit.textScore ?? null,
        rankScore: contribution,
        reasons,
      });
    }
  });

  textHits.forEach((hit, index) => {
    const rank = hit.textRank ?? index + 1;
    const existing = byId.get(hit.id);
    const contribution = 1 / (k + rank);
    const reasons = [`text rank #${rank}`];
    if (typeof hit.textScore === 'number') {
      reasons.push(`ts_rank ${hit.textScore.toFixed(3)}`);
    }
    if (existing) {
      existing.rankScore += contribution;
      existing.textRank = rank;
      existing.textScore = hit.textScore ?? existing.textScore ?? null;
      existing.reasons.push(...reasons);
    } else {
      byId.set(hit.id, {
        ...hit,
        source: hit,
        vectorRank: null,
        textRank: rank,
        vectorScore: hit.vectorScore ?? null,
        textScore: hit.textScore ?? null,
        rankScore: contribution,
        reasons,
      });
    }
  });

  return [...byId.values()]
    .sort((a, b) => b.rankScore - a.rankScore || a.id.localeCompare(b.id))
    .slice(0, limit);
}
