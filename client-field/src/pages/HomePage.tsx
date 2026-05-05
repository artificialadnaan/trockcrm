import { useAuth } from "@/lib/auth";

export function HomePage() {
  const { user } = useAuth();
  const name = user?.firstName || user?.email || "there";

  return (
    <section className="rounded-lg border border-border bg-white p-5 shadow-sm">
      <h1 className="text-2xl font-bold">Welcome, {name}.</h1>
      <p className="mt-2 text-muted-foreground">Project list is live. Capture and profile tools are coming soon.</p>
    </section>
  );
}
