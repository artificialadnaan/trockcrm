import { FormEvent, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { Button, TextInput } from "@/components/ui";

export function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>((location.state as { authError?: string } | null)?.authError ?? null);

  if (user) return <Navigate to="/projects" replace />;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!email.trim() || !password) {
      setError("Email and password are required.");
      return;
    }
    setSubmitting(true);
    try {
      await login(email.trim(), password);
      navigate("/projects", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to sign in.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted px-4 py-8">
      <section className="w-full max-w-sm rounded-lg border border-border bg-white p-6 shadow-sm">
        <div className="mb-6">
          <p className="text-sm font-bold uppercase tracking-wide text-primary">T Rock</p>
          <h1 className="text-3xl font-bold">Field App</h1>
        </div>
        <form className="space-y-4" onSubmit={onSubmit}>
          <label className="block space-y-2">
            <span className="text-sm font-semibold">Email</span>
            <TextInput autoComplete="email" inputMode="email" name="email" value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
          <label className="block space-y-2">
            <span className="text-sm font-semibold">Password</span>
            <TextInput autoComplete="current-password" name="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          {error ? <p className="rounded-md bg-red-50 p-3 text-sm font-medium text-red-700">{error}</p> : null}
          <Button className="w-full" disabled={submitting} type="submit">
            {submitting ? "Signing in..." : "Sign In"}
          </Button>
        </form>
        <p className="mt-5 text-center text-sm text-muted-foreground">Forgot password? Contact your administrator.</p>
      </section>
    </main>
  );
}
