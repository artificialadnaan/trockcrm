export function EstimateCopilotPanel({ dealId }: { dealId: string }) {
  return (
    <section className="rounded-lg border p-4">
      <h3 className="text-sm font-semibold">Copilot</h3>
      <p className="text-sm text-muted-foreground">Ask estimating questions for deal {dealId}.</p>
    </section>
  );
}
