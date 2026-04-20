export function EstimateOverviewPanel({ dealId }: { dealId: string }) {
  return (
    <section className="rounded-lg border p-4">
      <h3 className="text-sm font-semibold">Overview</h3>
      <p className="text-sm text-muted-foreground">Estimating workflow for deal {dealId}.</p>
    </section>
  );
}
