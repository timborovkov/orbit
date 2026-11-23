import Link from 'next/link';
import { notFound } from 'next/navigation';

import { z } from 'zod';

import { saveIntroductionConsent } from '@/actions/introductions';
import { WorkspaceField, WorkspaceSelect } from '@/app/workspace-field';
import { WorkspaceForm } from '@/app/workspace-form';
import { Badge } from '@/components/ui/badge';
import { FieldGroup } from '@/components/ui/field';
import { formatUtcTimestamp } from '@/lib/format';
import { getIntroduction } from '@/lib/server/introduction-queries';
import { personHref } from '@/lib/server/people-queries';

const consentLabels = {
  waiting: 'Awaiting decision',
  agreed: 'Agreed',
  declined: 'Declined',
  revoked: 'Revoked',
};

type Introduction = NonNullable<Awaited<ReturnType<typeof getIntroduction>>>;

function PartyConsent({
  introductionId,
  party,
  counterpart,
  identitiesCurrent,
}: {
  introductionId: string;
  party: Introduction['parties'][number];
  counterpart: string;
  identitiesCurrent: boolean;
}) {
  const decisionId = `decision-${party.personId}`;
  const evidenceId = `evidence-${party.personId}`;
  const canRecord =
    party.decision === 'agreed' || (party.decision === 'waiting' && identitiesCurrent);
  return (
    <section
      className="rounded-lg border border-border p-4 space-y-4"
      aria-labelledby={`party-${party.personId}`}
    >
      <div className="people-control-row">
        <h3 id={`party-${party.personId}`}>
          <Link href={personHref(party.personId)}>{party.name}</Link>
        </h3>
        <Badge variant="secondary">{consentLabels[party.decision]}</Badge>
      </div>
      <div className="space-y-1">
        <p className="muted">Would share with {counterpart}</p>
        <p className="wrap-break-word">
          {party.name} — {party.blurb}
        </p>
      </div>
      {party.evidence && party.updatedAt && (
        <div className="space-y-1">
          <p className="muted">Evidence · {formatUtcTimestamp(party.updatedAt)}</p>
          <p className="wrap-break-word">{party.evidence}</p>
        </div>
      )}
      {canRecord && (
        <WorkspaceForm
          key={party.decision}
          action={saveIntroductionConsent}
          label={party.decision === 'agreed' ? 'Record revocation' : 'Record decision'}
        >
          <input type="hidden" name="introductionId" value={introductionId} />
          <input type="hidden" name="personId" value={party.personId} />
          <FieldGroup>
            {party.decision === 'agreed' ? (
              <input type="hidden" name="decision" value="revoked" />
            ) : (
              <WorkspaceSelect
                id={decisionId}
                name="decision"
                label="Decision"
                initialValue=""
                options={[
                  { value: 'agreed', label: 'Agreed' },
                  { value: 'declined', label: 'Declined' },
                ]}
              />
            )}
            <WorkspaceField
              id={evidenceId}
              name="evidence"
              label="Evidence reference"
              description="Reference the decision on these exact details."
              maxLength={1000}
              required
            />
          </FieldGroup>
        </WorkspaceForm>
      )}
    </section>
  );
}

export default async function IntroductionPage({ params }: { params: Promise<{ id: string }> }) {
  const parsed = z.uuid().safeParse((await params).id);
  if (!parsed.success) notFound();
  const introduction = await getIntroduction(parsed.data);
  if (!introduction) notFound();
  return (
    <>
      <Link href="/people/introductions">Back to Introductions</Link>
      <div className="people-heading">
        <h1>{introduction.parties.map(({ name }) => name).join(' and ')}</h1>
        <Badge variant={introduction.blockedReason ? 'destructive' : 'outline'}>
          {introduction.status}
        </Badge>
      </div>
      {introduction.blockedReason && <p>{introduction.blockedReason}</p>}
      <div className="space-y-2">
        <Link
          href={`/agents/${introduction.agentId}?run=${introduction.runId}#run-${introduction.runId}`}
        >
          Proposed by {introduction.agentName} · View run
        </Link>
        <p className="wrap-break-word">{introduction.rationale}</p>
      </div>
      <section className="space-y-4" aria-labelledby="introduction-scope">
        <h2 id="introduction-scope">Disclosure and consent</h2>
        <div className="grid gap-4 md:grid-cols-2">
          {introduction.parties.map((party, i) => (
            <PartyConsent
              key={party.personId}
              party={party}
              counterpart={introduction.parties[1 - i].name}
              identitiesCurrent={introduction.identitiesCurrent}
              introductionId={introduction.id}
            />
          ))}
        </div>
      </section>
      {introduction.draft && (
        <section className="space-y-3" aria-labelledby="introduction-draft">
          <h2 id="introduction-draft">Introduction draft</h2>
          <blockquote className="approvals-preview">{introduction.draft}</blockquote>
          {introduction.reviewStatus === 'approved' && (
            <p className="muted">Administrator approved the draft.</p>
          )}
          <Link href={`/approvals?agent=${introduction.agentId}`}>View in Approvals</Link>
        </section>
      )}
    </>
  );
}
