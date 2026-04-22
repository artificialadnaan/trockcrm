export interface DashboardKpiItem {
  label: string;
  value: string;
  detail?: string;
  tone?: "default" | "danger" | "warning";
}

export function DashboardKpiBand({ items }: { items: DashboardKpiItem[] }) {
  const toneClasses = {
    default: {
      card: "border-gray-200 bg-white",
      label: "text-gray-400",
      value: "text-gray-900",
      accent: "bg-gray-900",
    },
    warning: {
      card: "border-amber-200 bg-amber-50/70",
      label: "text-amber-500",
      value: "text-amber-950",
      accent: "bg-amber-500",
    },
    danger: {
      card: "border-rose-200 bg-rose-50/70",
      label: "text-rose-500",
      value: "text-rose-950",
      accent: "bg-rose-500",
    },
  } satisfies Record<NonNullable<DashboardKpiItem["tone"]>, { card: string; label: string; value: string; accent: string }>;

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
      {items.map((item) => (
        <div
          key={item.label}
          className={`rounded-2xl border p-4 shadow-sm ${
            toneClasses[item.tone ?? "default"].card
          }`}
        >
          <div className={`h-1.5 w-10 rounded-full ${toneClasses[item.tone ?? "default"].accent}`} />
          <p className={`mt-3 text-[11px] font-semibold uppercase tracking-widest ${toneClasses[item.tone ?? "default"].label}`}>
            {item.label}
          </p>
          <p className={`mt-2 text-3xl font-black ${toneClasses[item.tone ?? "default"].value}`}>{item.value}</p>
          {item.detail ? <p className="mt-1 text-sm text-gray-500">{item.detail}</p> : null}
        </div>
      ))}
    </div>
  );
}
