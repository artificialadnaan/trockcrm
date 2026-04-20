export function EstimateCatalogMatchTable({ rows }: { rows: any[] }) {
  return (
    <section className="rounded-lg border p-4">
      <h3 className="text-sm font-semibold">Catalog Match</h3>
      <p className="text-sm text-muted-foreground">{rows.length} catalog matches.</p>
    </section>
  );
}
