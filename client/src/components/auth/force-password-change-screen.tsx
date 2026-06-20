import { useState } from "react";
import { Eye, EyeOff, ShieldCheck } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

function PasswordField({
  id,
  label,
  value,
  autoComplete,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  autoComplete: string;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="space-y-2">
      <label className="text-sm font-medium text-slate-700" htmlFor={id}>
        {label}
      </label>
      <div className="relative">
        <Input
          id={id}
          type={visible ? "text" : "password"}
          value={value}
          onChange={onChange}
          autoComplete={autoComplete}
          className="pr-10"
        />
        <button
          type="button"
          onClick={() => setVisible((prev) => !prev)}
          aria-label={`${visible ? "Hide" : "Show"} ${label.toLowerCase()}`}
          aria-pressed={visible}
          className="absolute inset-y-0 right-0 flex items-center px-3 text-slate-500 transition-colors hover:text-slate-700"
        >
          {visible ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
}

export function ForcePasswordChangeScreen() {
  const { user, changePassword, logout } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    if (newPassword !== confirmPassword) {
      setError("New password and confirmation must match");
      return;
    }

    setSubmitting(true);
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Password change failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" />
            Change your password
          </CardTitle>
          <CardDescription>
            {user?.email} must set a new password before accessing the rest of the CRM.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={handleSubmit}>
            {/* Hidden username field: lets password managers associate and UPDATE the saved credential
                with this account. Without it they orphan the new password and keep autofilling the
                stale/temporary one at the login screen, which then fails. */}
            <input
              type="text"
              name="username"
              autoComplete="username"
              value={user?.email ?? ""}
              readOnly
              tabIndex={-1}
              aria-hidden="true"
              className="sr-only"
            />
            <PasswordField
              id="current-password"
              label="Current temporary password"
              value={currentPassword}
              autoComplete="current-password"
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
            <PasswordField
              id="new-password"
              label="New password"
              value={newPassword}
              autoComplete="new-password"
              onChange={(event) => setNewPassword(event.target.value)}
            />
            <PasswordField
              id="confirm-password"
              label="Confirm new password"
              value={confirmPassword}
              autoComplete="new-password"
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
            {error ? (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </div>
            ) : null}
            <div className="flex items-center gap-2">
              <Button type="submit" disabled={submitting}>
                {submitting ? "Saving..." : "Change password"}
              </Button>
              <Button type="button" variant="ghost" onClick={logout} disabled={submitting}>
                Sign out
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
