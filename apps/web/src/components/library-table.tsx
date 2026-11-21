export function LibraryTable({
  columns,
  children,
  hasActions = true,
}: {
  columns: string[];
  children: React.ReactNode;
  hasActions?: boolean;
}) {
  return (
    <div className="library-table-wrap">
      <table className="library-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col">
                {column}
              </th>
            ))}
            {hasActions && (
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function LibraryEmpty({
  title,
  description,
}: {
  title: string;
  description: React.ReactNode;
}) {
  return (
    <div className="library-empty">
      <h2>{title}</h2>
      <p>{description}</p>
    </div>
  );
}

export function LibraryPageHeading({
  title,
  description,
  action,
}: {
  title: string;
  description: React.ReactNode;
  action: React.ReactNode;
}) {
  return (
    <div className="page-heading library-page-heading">
      <div>
        <h1>{title}</h1>
        <p className="muted">{description}</p>
      </div>
      {action}
    </div>
  );
}
