import { FormEvent, useEffect, useMemo, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { Button, TextInput } from "@/components/ui";

const MIN_PASSWORD_LENGTH = 8;

export function AcceptInvitePage() {
  const { user, acceptInvite, previewInvite } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get("token") ?? "";
  const [preview, setPreview] = useState<{ firstName: string; lastName: string; email: string } | null>(null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(Boolean(token));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(token ? null : "This invite link is invalid. Please contact your administrator for a new invite.");

  const passwordHint = useMemo(() => {
    if (!password) return "Use at least 8 characters.";
    if (password.length < MIN_PASSWORD_LENGTH) return "Password is too short.";
    if (confirmPassword && password !== confirmPassword) return "Passwords do not match.";
    return "Password looks ready.";
  }, [confirmPassword, password]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    previewInvite(token)
      .then((payload) => {
        if (!cancelled) setPreview(payload);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "This invite link is invalid. Please contact your administrator for a new invite.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [previewInvite, token]);

  if (user) return <Navigate to="/projects" replace />;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!token || !preview) {
      setError("This invite link is invalid. Please contact your administrator for a new invite.");
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setSubmitting(true);
    try {
      await acceptInvite(token, password);
      navigate("/projects", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to accept invite.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted px-4 py-8">
      <section className="w-full max-w-sm rounded-lg border border-border bg-white p-6 shadow-sm">
        <p className="text-sm font-bold uppercase tracking-wide text-primary">T Rock Field</p>
        <h1 className="mt-1 text-3xl font-bold">Accept invite</h1>
        {loading ? <p className="mt-5 text-muted-foreground">Loading invite...</p> : null}
        {!loading && preview ? (
          <form className="mt-5 space-y-4" onSubmit={onSubmit}>
            <p className="rounded-md bg-muted p-3 text-sm">
              Joining as <strong>{preview.firstName} {preview.lastName}</strong><br />
              <span className="text-muted-foreground">{preview.email}</span>
            </p>
            <label className="block space-y-2">
              <span className="text-sm font-semibold">Password</span>
              <TextInput autoComplete="new-password" name="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
            </label>
            <label className="block space-y-2">
              <span className="text-sm font-semibold">Confirm password</span>
              <TextInput autoComplete="new-password" name="confirmPassword" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
            </label>
            <p className="text-sm text-muted-foreground">{passwordHint}</p>
            {error ? <p className="rounded-md bg-red-50 p-3 text-sm font-medium text-red-700">{error}</p> : null}
            <Button className="w-full" disabled={submitting} type="submit">
              {submitting ? "Creating account..." : "Create Account"}
            </Button>
          </form>
        ) : null}
        {!loading && !preview && error ? <p className="mt-5 rounded-md bg-red-50 p-3 text-sm font-medium text-red-700">{error}</p> : null}
      </section>
    </main>
  );
}
