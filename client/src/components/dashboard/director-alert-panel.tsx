export function DirectorAlertPanel({
  staleDeals,
  staleLeads,
}: {
  staleDeals: Array<{
    dealId: string;
    dealName: string;
    repName: string;
    daysInStage: number;
    stageName: string;
  }>;
  staleLeads: Array<{
    leadId: string;
    leadName: string;
    repName: string;
    daysInStage: number;
    stageName: string;
  }>;
}) {
  const items = [
    ...staleDeals.slice(0, 2).map((row) => ({
      key: row.dealId,
      title: row.dealName,
      detail: `${row.repName} • ${row.daysInStage}d in ${row.stageName}`,
    })),
    ...staleLeads.slice(0, 1).map((row) => ({
      key: row.leadId,
      title: row.leadName,
      detail: `${row.repName} • ${row.daysInStage}d in ${row.stageName}`,
    })),
  ];

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <h3 className="text-sm font-bold uppercase tracking-wide text-gray-900">Needs attention</h3>
      <div className="mt-4 space-y-2">
        {items.length === 0 ? (
          <p className="text-sm text-gray-500">No stale work is flagged right now.</p>
        ) : null}
        {items.map((item) => (
          <div key={item.key} className="rounded-xl bg-amber-50 px-3 py-3">
            <p className="text-sm font-semibold text-gray-900">{item.title}</p>
            <p className="mt-1 text-sm text-gray-600">{item.detail}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
