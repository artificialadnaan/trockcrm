import { FormEvent, useEffect, useMemo, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { Eye, EyeOff } from "lucide-react";
import { useAuth } from "../lib/auth";
import { Button, TextInput } from "../components/ui";
import { BrandLogo } from "../components/BrandLogo";

const MIN_PASSWORD_LENGTH = 8;

function PasswordField({
  name,
  label,
  value,
  autoComplete,
  onChange,
}: {
  name: string;
  label: string;
  value: string;
  autoComplete: string;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <label className="block space-y-2">
      <span className="text-sm font-semibold">{label}</span>
      <div className="relative">
        <TextInput
          name={name}
          type={visible ? "text" : "password"}
          autoComplete={autoComplete}
          value={value}
          onChange={onChange}
          className="pr-12"
        />
        <button
          type="button"
          onClick={() => setVisible((prev) => !prev)}
          aria-label={`${visible ? "Hide" : "Show"} ${label.toLowerCase()}`}
          aria-pressed={visible}
          className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground transition hover:text-foreground"
        >
          {visible ? <EyeOff className="h-5 w-5" aria-hidden="true" /> : <Eye className="h-5 w-5" aria-hidden="true" />}
        </button>
      </div>
    </label>
  );
}

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
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-white via-muted to-white px-4 py-8">
      <section className="w-full max-w-sm overflow-hidden rounded-2xl border border-border bg-white shadow-[0_24px_60px_rgba(15,23,42,0.08)]">
        <div className="h-1 bg-primary" />
        <div className="p-6">
          <div className="mb-5 flex items-start gap-4">
            <BrandLogo className="h-14 w-auto" />
            <div className="pt-1">
              <p className="text-xs font-black uppercase tracking-[0.24em] text-primary">Field App</p>
              <h1 className="mt-1 text-3xl font-black">Accept invite</h1>
            </div>
          </div>
          {loading ? <p className="mt-5 text-muted-foreground">Loading invite...</p> : null}
          {!loading && preview ? (
            <form className="mt-5 space-y-4" onSubmit={onSubmit}>
              <p className="rounded-md bg-muted p-3 text-sm">
                Joining as <strong>{preview.firstName} {preview.lastName}</strong><br />
                <span className="text-muted-foreground">{preview.email}</span>
              </p>
              {/* Hidden username field: lets password managers associate and save the new credential
                  with this account instead of orphaning it (then autofilling a stale value at login). */}
              <input
                type="text"
                name="username"
                autoComplete="username"
                value={preview.email}
                readOnly
                tabIndex={-1}
                aria-hidden="true"
                className="sr-only"
              />
              <PasswordField
                name="password"
                label="Password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <PasswordField
                name="confirmPassword"
                label="Confirm password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
              />
              <p className="text-sm text-muted-foreground">{passwordHint}</p>
              {error ? <p className="rounded-md bg-red-50 p-3 text-sm font-medium text-red-700">{error}</p> : null}
              <Button className="w-full" disabled={submitting} type="submit">
                {submitting ? "Creating account..." : "Create Account"}
              </Button>
            </form>
          ) : null}
          {!loading && !preview && error ? <p className="mt-5 rounded-md bg-red-50 p-3 text-sm font-medium text-red-700">{error}</p> : null}
        </div>
      </section>
    </main>
  );
}
