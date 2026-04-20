export function EstimatePricingReviewTable({ rows }: { rows: any[] }) {
  return (
    <section className="rounded-lg border p-4">
      <h3 className="text-sm font-semibold">Draft Pricing</h3>
      <p className="text-sm text-muted-foreground">{rows.length} pricing recommendations.</p>
    </section>
  );
}
