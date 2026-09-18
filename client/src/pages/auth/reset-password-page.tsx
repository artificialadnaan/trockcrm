import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { ArrowRight, Eye, EyeOff, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Both numbers mirror the server's reset policy and are user-facing copy on this page and on the
// request form in auth-entry-screen — change them together with the server or the screens start lying.
const MIN_PASSWORD_LENGTH = 12;
const LINK_TTL_MINUTES = 60;

// The reset link carries its token in the URL FRAGMENT (`#token=...`). A fragment is never sent to the
// server, so the token stays out of access logs and the Referer header. Read it exactly once per page
// load and memoize the result: React StrictMode remounts this page in dev, and a second mount would
// otherwise read the already-stripped hash and declare a live link dead.
let consumedToken: string | null = null;

function readResetToken(): string {
  if (consumedToken === null) {
    const fragment = window.location.hash.replace(/^#/, "");
    consumedToken = new URLSearchParams(fragment).get("token")?.trim() ?? "";
  }
  return consumedToken;
}

/** Test-only: forget the memoized fragment so each case can simulate a fresh page load. */
export function resetConsumedTokenForTests() {
  consumedToken = null;
}

type ResetPhase = "validating" | "invalid" | "ready" | "complete";

function ResetShell({ children }: { children: ReactNode }) {
  return (
    <main className="grid min-h-screen place-items-center bg-slate-50 px-6 py-10 text-slate-950">
      <div className="w-full max-w-md">
        <div className="flex items-center gap-4">
          <img className="h-11 w-11 rounded-sm object-contain" src="/logo.png" alt="T Rock" />
          <div>
            <p className="text-lg font-black leading-tight tracking-normal">T Rock Construction CRM</p>
            <p className="text-xs font-bold uppercase tracking-normal text-slate-500">Password reset</p>
          </div>
        </div>
        <div className="mt-10">{children}</div>
      </div>
    </main>
  );
}

function SignInLink({ children }: { children: ReactNode }) {
  return (
    <a
      className="mt-8 inline-flex h-14 w-full items-center justify-center rounded-lg bg-brand-red text-base font-black text-white shadow-sm transition hover:bg-red-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red/60 focus-visible:ring-offset-2"
      href="/login"
    >
      {children}
      <ArrowRight className="ml-2 h-5 w-5" aria-hidden="true" />
    </a>
  );
}

function PasswordField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="space-y-2">
      <label className="text-sm font-bold text-slate-800" htmlFor={id}>
        {label}
      </label>
      <div className="relative">
        <Input
          id={id}
          type={visible ? "text" : "password"}
          value={value}
          onChange={onChange}
          autoComplete="new-password"
          required
          className="h-14 rounded-lg border-slate-200 bg-white px-4 pr-12 text-base shadow-sm transition focus-visible:ring-2 focus-visible:ring-brand-red/60"
        />
        <button
          type="button"
          onClick={() => setVisible((prev) => !prev)}
          aria-label={`${visible ? "Hide" : "Show"} ${label.toLowerCase()}`}
          aria-pressed={visible}
          className="absolute inset-y-0 right-0 flex items-center px-4 text-slate-500 transition-colors hover:text-slate-700"
        >
          {visible ? <EyeOff className="h-5 w-5" aria-hidden="true" /> : <Eye className="h-5 w-5" aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
}

export function ResetPasswordPage() {
  const [token] = useState(readResetToken);
  const [phase, setPhase] = useState<ResetPhase>(token ? "validating" : "invalid");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Strip the fragment before paint: the token is already in component state, and leaving it in the
  // address bar would keep it in the session history where a back-navigation (or a shoulder) recovers it.
  useLayoutEffect(() => {
    if (!window.location.hash) return;
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
  }, []);

  useEffect(() => {
    if (!token) return;
    let active = true;

    (async () => {
      try {
        const result = await api<{ valid?: boolean }>("/auth/password-reset/validate", {
          method: "POST",
          json: { token },
        });
        if (active) setPhase(result?.valid === true ? "ready" : "invalid");
      } catch {
        // Every failure mode — expired, already used, offline, 500 — collapses to the same dead end,
        // because the user's only useful next step is a fresh link regardless of the reason.
        if (active) setPhase("invalid");
      }
    })();

    return () => {
      active = false;
    };
  }, [token]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirmPassword) {
      setError("Those two passwords do not match.");
      return;
    }

    setSubmitting(true);
    try {
      await api("/auth/password-reset/complete", { method: "POST", json: { token, password } });
      setPhase("complete");
    } catch (err) {
      setError(err instanceof Error ? err.message : "We could not reset your password.");
    } finally {
      setSubmitting(false);
    }
  };

  if (phase === "validating") {
    return (
      <ResetShell>
        <div className="flex items-center gap-3 text-slate-500" role="status">
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
          <span className="text-sm font-semibold">Checking your reset link...</span>
        </div>
      </ResetShell>
    );
  }

  if (phase === "invalid") {
    return (
      <ResetShell>
        <h1 className="text-4xl font-black tracking-normal text-slate-950">This link is no longer valid</h1>
        <p className="mt-3 text-base leading-6 text-slate-500">
          Reset links expire {LINK_TTL_MINUTES} minutes after they are sent, and each one works only once.
          Request a new one from the sign-in screen.
        </p>
        <SignInLink>Request a new link</SignInLink>
      </ResetShell>
    );
  }

  if (phase === "complete") {
    return (
      <ResetShell>
        <h1 className="text-4xl font-black tracking-normal text-slate-950">Password updated</h1>
        <p className="mt-3 text-base leading-6 text-slate-500">
          You have been signed out everywhere as a precaution. Sign in again with your new password.
        </p>
        <SignInLink>Sign in</SignInLink>
      </ResetShell>
    );
  }

  return (
    <ResetShell>
      <h1 className="text-4xl font-black tracking-normal text-slate-950">Choose a new password</h1>
      <p className="mt-3 text-base leading-6 text-slate-500">
        At least {MIN_PASSWORD_LENGTH} characters. Setting it signs you out of every other device.
      </p>

      <form className="mt-8 space-y-5" onSubmit={handleSubmit}>
        <PasswordField
          id="new-password"
          label="New password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <PasswordField
          id="confirm-password"
          label="Confirm new password"
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
        />
        {error ? (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700" role="alert">
            {error}
          </div>
        ) : null}
        <Button
          className="h-14 w-full rounded-lg bg-brand-red text-base font-black text-white shadow-sm transition hover:bg-red-800 focus-visible:ring-2 focus-visible:ring-brand-red/60 focus-visible:ring-offset-2"
          type="submit"
          disabled={submitting}
        >
          {submitting ? (
            <>
              <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden="true" />
              Saving...
            </>
          ) : (
            <>
              Set new password
              <ArrowRight className="ml-2 h-5 w-5" aria-hidden="true" />
            </>
          )}
        </Button>
      </form>
    </ResetShell>
  );
}
