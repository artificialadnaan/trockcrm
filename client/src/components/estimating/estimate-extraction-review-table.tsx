export function EstimateExtractionReviewTable({ rows }: { rows: any[] }) {
  return (
    <section className="rounded-lg border p-4">
      <h3 className="text-sm font-semibold">Extraction</h3>
      <p className="text-sm text-muted-foreground">{rows.length} extracted scope rows.</p>
    </section>
  );
}
