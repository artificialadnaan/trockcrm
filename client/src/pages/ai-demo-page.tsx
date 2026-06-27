import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { GreenChatPanel } from "@/components/ai/green-chat-panel";

/**
 * The T Rock AI demo page. Self-contained page gate: checks the demo session, shows the
 * DEMO_PASSWORD form until authenticated, then the chat. This is gated by the demo password (not
 * CRM auth), so it lives outside the CRM AppShell.
 */
export function AiDemoPage() {
  const [authed, setAuthed] = useState<boolean | null>(null); // null = still checking
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/session", { credentials: "include" })
      .then((r) => active && setAuthed(r.ok))
      .catch(() => active && setAuthed(false));
    return () => {
      active = false;
    };
  }, []);

  const login = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch("/api/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (r.ok) setAuthed(true);
      else setError("Incorrect password.");
    } catch {
      setError("Login failed — please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (authed === null) {
    return <div className="p-8 text-center text-muted-foreground">Loading…</div>;
  }

  if (!authed) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>T Rock AI</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">Enter the demo password to continue.</p>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && login()}
              placeholder="Demo password"
              autoFocus
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button className="w-full" onClick={login} disabled={submitting || password.length === 0}>
              {submitting ? "Checking…" : "Enter"}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="h-screen">
      <GreenChatPanel />
    </div>
  );
}
