import { useEffect, useState } from "react";
import { LogIn, KeyRound } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

interface DevUser {
  id: string;
  email: string;
  displayName: string;
  role: string;
}

export function AuthEntryScreen() {
  const { localLogin, login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devUsers, setDevUsers] = useState<DevUser[]>([]);
  const [devReady, setDevReady] = useState(false);

  useEffect(() => {
    api<{ users: DevUser[] }>("/auth/dev/users")
      .then((data) => {
        setDevUsers(data.users);
        setDevReady(true);
      })
      .catch(() => {
        setDevReady(false);
      });
  }, []);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      await localLogin(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-100 px-4 py-12">
      <div className="mx-auto flex max-w-5xl flex-col gap-6 lg:flex-row">
        <Card className="flex-1">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xl">
              <KeyRound className="h-5 w-5" />
              T Rock CRM
            </CardTitle>
            <CardDescription>
              Sign in with your temporary local password. If it is your first login, you will be
              prompted to change it immediately.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={handleSubmit}>
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700" htmlFor="email">
                  Email
                </label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@company.com"
                  autoComplete="username"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700" htmlFor="password">
                  Password
                </label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Temporary password"
                  autoComplete="current-password"
                />
              </div>
              {error ? (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  {error}
                </div>
              ) : null}
              <Button className="w-full" type="submit" disabled={submitting}>
                <LogIn className="mr-2 h-4 w-4" />
                {submitting ? "Signing in..." : "Sign in"}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card className="flex-1">
          <CardHeader>
            <CardTitle>Testing access</CardTitle>
            <CardDescription>
              Dev-mode quick login remains available locally for role and workflow testing.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {devReady ? (
              devUsers.map((user) => (
                <Button
                  key={user.id}
                  variant="outline"
                  className="flex h-auto w-full items-center justify-between py-3"
                  onClick={() => login(user.email)}
                >
                  <div className="text-left">
                    <div className="text-sm font-medium">{user.displayName}</div>
                    <div className="text-xs text-slate-500">{user.email}</div>
                  </div>
                  <Badge variant="outline">{user.role}</Badge>
                </Button>
              ))
            ) : (
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-4 text-sm text-slate-600">
                Dev login is not available in this environment.
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
