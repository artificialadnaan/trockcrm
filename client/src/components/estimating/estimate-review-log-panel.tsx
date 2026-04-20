export function EstimateReviewLogPanel({ events }: { events: any[] }) {
  return (
    <section className="rounded-lg border p-4">
      <h3 className="text-sm font-semibold">Review Log</h3>
      <p className="text-sm text-muted-foreground">{events.length} review events.</p>
    </section>
  );
}
