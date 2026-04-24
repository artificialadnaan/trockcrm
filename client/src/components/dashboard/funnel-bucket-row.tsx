import type { FunnelBucketSummary } from "@/hooks/use-dashboard";
import { FunnelBucketCard } from "./funnel-bucket-card";

export function FunnelBucketRow({ buckets }: { buckets: FunnelBucketSummary[] }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {buckets.map((bucket) => (
        <FunnelBucketCard key={bucket.key} bucket={bucket} />
      ))}
    </div>
  );
}
