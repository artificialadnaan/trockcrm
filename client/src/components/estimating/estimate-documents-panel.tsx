export function EstimateDocumentsPanel({ documents }: { dealId: string; documents: any[] }) {
  return (
    <section className="rounded-lg border p-4">
      <h3 className="text-sm font-semibold">Documents</h3>
      <p className="text-sm text-muted-foreground">{documents.length} uploaded source documents.</p>
    </section>
  );
}
