import { FormEvent, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { Button, TextInput } from "../components/ui";
import { BrandLogo } from "../components/BrandLogo";

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
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-white via-muted to-white px-4 py-8">
      <section className="w-full max-w-sm overflow-hidden rounded-2xl border border-border bg-white shadow-[0_24px_60px_rgba(15,23,42,0.08)]">
        <div className="h-1 bg-primary" />
        <div className="p-6">
          <div className="mb-6 flex items-start gap-4">
            <BrandLogo className="h-16 w-auto" surfaceClassName="rounded-2xl px-4 py-3" />
            <div className="pt-1">
              <p className="text-xs font-black uppercase tracking-[0.24em] text-primary">Field App</p>
              <h1 className="mt-1 text-3xl font-black text-slate-950">Sign in</h1>
              <p className="mt-1 text-sm font-medium text-muted-foreground">T Rock Construction</p>
            </div>
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
            <Button className="w-full rounded-lg" disabled={submitting} type="submit">
              {submitting ? "Signing in..." : "Sign In"}
            </Button>
          </form>
          <p className="mt-5 text-center text-sm text-muted-foreground">Forgot password? Contact your administrator.</p>
        </div>
      </section>
    </main>
  );
}
