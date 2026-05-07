import { Link } from "react-router-dom";
import { formatCurrency } from "@/components/charts/chart-colors";
import type { FunnelBucketSummary } from "@/hooks/use-dashboard";

export function FunnelBucketCard({ bucket }: { bucket: FunnelBucketSummary }) {
  const href = `${bucket.route}?bucket=${bucket.bucket}`;

  return (
    <Link
      to={href}
      className="group rounded-xl border bg-card p-4 transition-colors hover:bg-slate-50"
    >
      <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">
        {bucket.label}
      </p>
      <p className="mt-3 text-4xl font-black leading-none text-gray-900">
        {bucket.count}
      </p>
      <p className="mt-2 text-xs font-semibold text-gray-500">
        {bucket.totalValue == null ? "Count only" : formatCurrency(bucket.totalValue)}
      </p>
    </Link>
  );
}
