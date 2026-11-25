import { notFound } from 'next/navigation';

import { EvaluationComparisonView } from '@/app/evaluation-comparison-view';
import { env } from '@/lib/env';
import { getEvaluationComparison } from '@/lib/server/evaluation-queries';

export const dynamic = 'force-dynamic';

export default async function EvaluationComparisonPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const detail = await getEvaluationComparison(id);
  if (!detail) notFound();

  return (
    <main className="workspace-main" id="main" tabIndex={-1}>
      {env().AUTH_DISABLED && (
        <p className="local-auth-notice" role="status">
          Authentication disabled · Local development
        </p>
      )}
      <EvaluationComparisonView detail={detail} />
    </main>
  );
}
