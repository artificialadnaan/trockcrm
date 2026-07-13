import { useEffect, useState } from "react";
import { GreenChatPanel } from "@/components/ai/green-chat-panel";
import { LittleTAvatar } from "@/components/ai/little-t-avatar";
import { isDemoSessionResponse } from "@/components/ai/demo-session";
import "@/components/ai/little-t.css";

/** Load the Little T webfonts only on this page (and only once). */
function useLittleTFonts() {
  useEffect(() => {
    if (document.getElementById("little-t-fonts")) return;
    const pre1 = Object.assign(document.createElement("link"), { rel: "preconnect", href: "https://fonts.googleapis.com" });
    const pre2 = Object.assign(document.createElement("link"), { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" });
    const css = Object.assign(document.createElement("link"), {
      id: "little-t-fonts",
      rel: "stylesheet",
      href: "https://fonts.googleapis.com/css2?family=Saira:wght@400;500;600;700&family=Saira+Condensed:wght@600;700&display=swap",
    });
    document.head.append(pre1, pre2, css);
  }, []);
}

/**
 * Little T — the T Rock assistant. Self-contained page gate: checks the demo session, shows the
 * DEMO_PASSWORD form until authenticated, then the chat. Gated by the demo password (not CRM auth),
 * so it lives outside the CRM AppShell. Everything is scoped under `.little-t`.
 */
export function AiDemoPage() {
  const [authed, setAuthed] = useState<boolean | null>(null); // null = still checking
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  useLittleTFonts();

  useEffect(() => {
    let active = true;
    fetch("/api/session", { credentials: "include" })
      .then(isDemoSessionResponse)
      .then((ok) => active && setAuthed(ok))
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
      else if (r.status === 401) setError("Incorrect password.");
      else if (r.status === 429) setError("Too many attempts — wait a minute and try again.");
      else setError("Login failed — please try again.");
    } catch {
      setError("Login failed — please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (authed === null) {
    return (
      <div className="little-t">
        <div className="lt-gate">
          <div style={{ textAlign: "center", color: "var(--lt-muted)" }}>
            <LittleTAvatar size="hero" />
            <div style={{ marginTop: 10, fontSize: 14 }}>Waking up Little T…</div>
          </div>
        </div>
      </div>
    );
  }

  if (!authed) {
    return (
      <div className="little-t">
        <div className="lt-gate">
          <div className="lt-gate-card">
            <LittleTAvatar size="hero" />
            <h1 className="lt-display">Little&nbsp;<span style={{ color: "var(--lt-red)" }}>T</span></h1>
            <div className="lt-tag2">The T Rock Assistant</div>
            <p>Enter the demo password to talk to Little T about the Dallas pipeline.</p>
            <input
              className="lt-field"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && login()}
              placeholder="Demo password"
              autoFocus
            />
            {error && <div className="lt-gate-err">{error}</div>}
            <button className="lt-btn" onClick={login} disabled={submitting || password.length === 0}>
              {submitting ? "Checking…" : "Enter →"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="little-t" style={{ height: "100vh" }}>
      <GreenChatPanel />
    </div>
  );
}
