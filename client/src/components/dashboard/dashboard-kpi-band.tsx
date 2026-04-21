export interface DashboardKpiItem {
  label: string;
  value: string;
  detail?: string;
  tone?: "default" | "danger" | "warning";
}

export function DashboardKpiBand({ items }: { items: DashboardKpiItem[] }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
      {items.map((item) => (
        <div key={item.label} className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-gray-400">{item.label}</p>
          <p className="mt-2 text-3xl font-black text-gray-900">{item.value}</p>
          {item.detail ? <p className="mt-1 text-sm text-gray-500">{item.detail}</p> : null}
        </div>
      ))}
    </div>
  );
}
