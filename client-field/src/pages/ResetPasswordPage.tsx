import { FormEvent, useEffect, useMemo, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { BrandLogo } from "../components/BrandLogo";
import { Button, TextInput } from "../components/ui";
import { api } from "../lib/api";

const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 256;
const INVALID_LINK_MESSAGE =
  "This password reset link is invalid or has expired. Please ask your administrator for a new link.";

type PasswordResetPreview = {
  firstName: string;
  lastName: string;
  email: string;
};

function PasswordField({
  name,
  label,
  value,
  onChange,
}: {
  name: string;
  label: string;
  value: string;
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
          autoComplete="new-password"
          maxLength={MAX_PASSWORD_LENGTH}
          value={value}
          onChange={onChange}
          className="pr-12"
        />
        <button
          type="button"
          onClick={() => setVisible((current) => !current)}
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

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get("token")?.trim() ?? "";
  const [preview, setPreview] = useState<PasswordResetPreview | null>(null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(Boolean(token));
  const [submitting, setSubmitting] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [error, setError] = useState<string | null>(token ? null : INVALID_LINK_MESSAGE);

  const passwordHint = useMemo(() => {
    if (!password) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
    if (password.length < MIN_PASSWORD_LENGTH) return "Password is too short.";
    if (confirmPassword && password !== confirmPassword) return "Passwords do not match.";
    return "Password looks ready.";
  }, [confirmPassword, password]);

  useEffect(() => {
    if (!token) return;

    const controller = new AbortController();
    setLoading(true);
    api<PasswordResetPreview>(`/auth/field-password-reset-preview?token=${encodeURIComponent(token)}`, {
      signal: controller.signal,
    })
      .then((payload) => {
        setPreview(payload);
      })
      .catch((requestError) => {
        if (!controller.signal.aborted) {
          setError(requestError instanceof Error ? requestError.message : INVALID_LINK_MESSAGE);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [token]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (!token || !preview) {
      setError(INVALID_LINK_MESSAGE);
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setSubmitting(true);
    try {
      await api("/auth/field-password-reset", {
        method: "POST",
        json: { token, newPassword: password },
      });
      setCompleted(true);
      setPassword("");
      setConfirmPassword("");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to reset password.");
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
              <h1 className="mt-1 text-3xl font-black">Reset password</h1>
            </div>
          </div>

          {loading ? <p className="mt-5 text-muted-foreground">Checking reset link...</p> : null}

          {!loading && completed ? (
            <div className="mt-5 space-y-4">
              <div className="rounded-lg bg-emerald-50 p-4 text-sm text-emerald-900">
                <p className="font-bold">Password reset.</p>
                <p className="mt-1">You can now sign in to T-Rock Cam with your new password.</p>
              </div>
              <Link
                to="/"
                className="inline-flex min-h-11 w-full items-center justify-center rounded-md bg-primary px-4 py-2 font-semibold text-primary-foreground shadow-sm transition hover:brightness-95"
              >
                Return to Sign In
              </Link>
            </div>
          ) : null}

          {!loading && !completed && preview ? (
            <form className="mt-5 space-y-4" onSubmit={onSubmit}>
              <p className="rounded-md bg-muted p-3 text-sm">
                Resetting password for <strong>{preview.firstName} {preview.lastName}</strong>
                <br />
                <span className="text-muted-foreground">{preview.email}</span>
              </p>
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
                label="New password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <PasswordField
                name="confirmPassword"
                label="Confirm new password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
              />
              <p className="text-sm text-muted-foreground">{passwordHint}</p>
              {error ? <p className="rounded-md bg-red-50 p-3 text-sm font-medium text-red-700">{error}</p> : null}
              <Button className="w-full" disabled={submitting} type="submit">
                {submitting ? "Resetting password..." : "Reset Password"}
              </Button>
            </form>
          ) : null}

          {!loading && !completed && !preview && error ? (
            <div className="mt-5 space-y-4">
              <p className="rounded-md bg-red-50 p-3 text-sm font-medium text-red-700">{error}</p>
              <Link className="block text-center text-sm font-medium underline underline-offset-4" to="/">
                Return to Sign In
              </Link>
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}
