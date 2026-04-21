export function DirectorActivitySummary({
  rows,
}: {
  rows: Array<{
    repId: string;
    repName: string;
    calls: number;
    emails: number;
    meetings: number;
    notes: number;
    total: number;
  }>;
}) {
  const topRows = rows.slice().sort((left, right) => right.total - left.total).slice(0, 5);

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <h3 className="text-sm font-bold uppercase tracking-wide text-gray-900">Activity summary</h3>
      <p className="mt-1 text-sm text-gray-500">
        Top activity contributors and team mix for the selected period.
      </p>
      <div className="mt-4 space-y-2">
        {topRows.map((row) => (
          <div
            key={row.repId}
            className="flex items-center justify-between rounded-xl bg-gray-50 px-3 py-2"
          >
            <span className="text-sm font-medium text-gray-900">{row.repName}</span>
            <span className="text-sm text-gray-500">{row.total} activities</span>
          </div>
        ))}
      </div>
    </section>
  );
}
