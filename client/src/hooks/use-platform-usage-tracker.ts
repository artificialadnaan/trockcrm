import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

const HEARTBEAT_INTERVAL_MS = 30_000;
const IDLE_MS = 300_000; // 5 minutes
const VIEW_FLUSH_MS = 10_000;

/** Pure decision: should a heartbeat fire right now? Exported for unit testing. */
export function shouldSendHeartbeat(s: { visibility: string; msSinceInteraction: number; idleMs: number }): boolean {
  return s.visibility === "visible" && s.msSinceInteraction < s.idleMs;
}

interface BufferedView { entityType: string; entityId: string | null; route: string; labelSnapshot: string | null; }

/** Map a route path to a view-event classification. Exported for unit testing. */
export function classifyRoute(pathname: string): BufferedView {
  const dealMatch = pathname.match(/^\/deals\/([0-9a-f-]{36})/i);
  if (dealMatch) return { entityType: "deal", entityId: dealMatch[1], route: pathname, labelSnapshot: null };
  const leadMatch = pathname.match(/^\/leads\/([0-9a-f-]{36})/i);
  if (leadMatch) return { entityType: "lead", entityId: leadMatch[1], route: pathname, labelSnapshot: null };
  if (pathname.startsWith("/reports")) return { entityType: "report", entityId: null, route: pathname, labelSnapshot: null };
  return { entityType: "page", entityId: null, route: pathname, labelSnapshot: null };
}

export function usePlatformUsageTracker(): void {
  const { user } = useAuth();
  const location = useLocation();
  const sessionIdRef = useRef<string | null>(null);
  const lastInteractionRef = useRef<number>(Date.now());
  const viewBufferRef = useRef<BufferedView[]>([]);

  // 1) Start a session once authenticated.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    void api<{ sessionId: string }>("/usage/session/start", { method: "POST" })
      .then((r) => { if (!cancelled) sessionIdRef.current = r.sessionId; })
      .catch(() => { /* telemetry is best-effort; never block the app */ });
    return () => { cancelled = true; };
  }, [user]);

  // 2) Track interaction recency.
  useEffect(() => {
    const mark = () => { lastInteractionRef.current = Date.now(); };
    const evts = ["mousemove", "keydown", "click", "scroll"] as const;
    for (const e of evts) window.addEventListener(e, mark, { passive: true });
    return () => { for (const e of evts) window.removeEventListener(e, mark); };
  }, []);

  // 3) Heartbeat loop (visibility + idle gated).
  useEffect(() => {
    if (!user) return;
    const id = window.setInterval(() => {
      const sid = sessionIdRef.current;
      if (!sid) return;
      const ok = shouldSendHeartbeat({
        visibility: document.visibilityState,
        msSinceInteraction: Date.now() - lastInteractionRef.current,
        idleMs: IDLE_MS,
      });
      if (!ok) return;
      void api("/usage/heartbeat", { method: "POST", json: { sessionId: sid } }).catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [user]);

  // 4) Record a view on each route change (buffered), including query-string-only navigations.
  useEffect(() => {
    if (!user) return;
    viewBufferRef.current.push(classifyRoute(location.pathname + location.search));
    lastInteractionRef.current = Date.now();
  }, [user, location.pathname, location.search]);

  // 5) Flush buffer on interval, on navigation unmount, and on pagehide (keepalive).
  useEffect(() => {
    if (!user) return;
    const flush = (keepalive = false) => {
      const sid = sessionIdRef.current;
      const events = viewBufferRef.current;
      if (!sid || events.length === 0) return;
      viewBufferRef.current = [];
      void api("/usage/events", { method: "POST", json: { sessionId: sid, events }, keepalive }).catch(() => {});
    };
    const intervalId = window.setInterval(() => flush(false), VIEW_FLUSH_MS);
    const onHide = () => flush(true);
    window.addEventListener("pagehide", onHide);
    return () => { window.clearInterval(intervalId); window.removeEventListener("pagehide", onHide); flush(false); };
  }, [user]);
}
