import { LoadingStatus } from '@/app/loading-status';

function ContentListSkeleton({ label = 'Loading…', rows = 4 }: { label?: string; rows?: number }) {
  return (
    <div className="content-skeleton" aria-hidden="true">
      <div className="content-skeleton-heading">
        <span className="overview-placeholder w-32" />
        <LoadingStatus>{label}</LoadingStatus>
      </div>
      <ul className="content-skeleton-list">
        {Array.from({ length: rows }, (_, index) => (
          <li key={index} className="content-skeleton-row">
            <span className="overview-placeholder w-16" />
            <span className="overview-placeholder w-full" />
            <span className="overview-placeholder w-20" />
          </li>
        ))}
      </ul>
    </div>
  );
}

function FormSkeleton({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="content-skeleton" aria-hidden="true">
      <div className="content-skeleton-heading">
        <span className="overview-placeholder w-40" />
        <LoadingStatus>{label}</LoadingStatus>
      </div>
      <div className="content-skeleton-form">
        {[0, 1, 2].map((row) => (
          <div key={row} className="content-skeleton-field">
            <span className="overview-placeholder w-24" />
            <span className="overview-placeholder content-skeleton-control" />
          </div>
        ))}
        <div className="content-skeleton-actions">
          <span className="overview-placeholder w-28" />
        </div>
      </div>
    </div>
  );
}

export function AgentWorkspaceSkeleton() {
  return (
    <div className="agent-shell">
      <main className="workspace-main" id="main" tabIndex={-1}>
        <div className="agent-workspace-skeleton" aria-hidden="true">
          <div className="agent-workspace-skeleton-header">
            <span className="avatar overview-placeholder" />
            <div className="overview-agent-placeholder">
              <span className="overview-placeholder w-40" />
              <span className="overview-placeholder w-24" />
            </div>
          </div>
          <div className="agent-workspace-skeleton-tabs">
            {[0, 1, 2, 3, 4].map((tab) => (
              <span key={tab} className="overview-placeholder w-20" />
            ))}
          </div>
          <ContentListSkeleton label="Loading agent workspace…" rows={5} />
        </div>
      </main>
    </div>
  );
}

export function ConsolePageSkeleton({
  titleWidth = 'w-32',
  kind = 'list',
}: {
  titleWidth?: string;
  kind?: 'list' | 'form';
}) {
  return (
    <main className="workspace-main" id="main" tabIndex={-1}>
      <div className="page-heading">
        <div>
          <span className={`overview-placeholder ${titleWidth} content-skeleton-title`} />
        </div>
      </div>
      {kind === 'form' ? <FormSkeleton /> : <ContentListSkeleton />}
    </main>
  );
}
