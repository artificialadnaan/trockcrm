import { Link } from "react-router-dom";
import type { AdminOperationsTile } from "@/lib/admin-dashboard-summary";

export function AdminOperationsWorkspace({ tiles }: { tiles: AdminOperationsTile[] }) {
  return (
    <section className="space-y-4" aria-label="Operations workspace">
      <div>
        <h2 className="text-lg font-semibold text-slate-950">Needs attention now</h2>
        <p className="text-sm text-slate-500">Operational queues and system signals that need review first.</p>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {tiles.map((tile) => (
          <Link
            key={tile.key}
            to={tile.href}
            className="rounded-2xl border border-slate-200 bg-white p-4 transition-colors hover:border-slate-300 hover:bg-slate-50"
          >
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold text-slate-900">{tile.title}</span>
                <span className="text-2xl font-semibold tracking-tight text-slate-950">{tile.valueLabel}</span>
              </div>
              <p className="text-xs uppercase tracking-[0.16em] text-slate-500">{tile.secondaryLabel}</p>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
