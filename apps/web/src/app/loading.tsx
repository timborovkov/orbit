export default function Loading() {
  return (
    <main className="route-state" aria-busy="true">
      <div role="status">
        <h1>Loading workspace</h1>
        <p>Retrieving your agents and recent activity.</p>
        <div className="loading-lines" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </div>
    </main>
  );
}
