// Bid Board → CRM sync HEARTBEAT / silence detector.
//
// Why this exists: the CRM ingest (server/src/modules/bid-board-sync/service.ts) runs in ONE
// transaction and ROLLS BACK on any error, so a failed run leaves NO bid_board_sync_runs row. A
// 2026-06-18 outage (a `$16` type-inference 500 on every push) therefore ran ~24h with zero failure
// trail — the only signal was the ABSENCE of a recent committed success. This job detects that
// absence per office and emails, independently of SyncHub (it runs in the CRM process, so it still
// fires if SyncHub is entirely down — the case a SyncHub-hosted heartbeat would miss).
//
// Runs as a dedicated Railway cron (recommended every ~20 min; cadence is ~19 min, threshold default
// 60 min ≈ 3 missed cycles). Reuses the canonical Resend sender. All config is env-driven; an empty
// recipients list is a full no-op so the job is inert until deliberately turned on.
import pg from "pg";
import { sendSystemEmail } from "../lib/resend-client.js";

export type AlertState = "ok" | "stalled";
export type HeartbeatAction = "alert_stalled" | "alert_recovered" | "none";

export interface HeartbeatDecisionInput {
  /** MAX(created_at) of committed-success runs for the office, or null if none has ever committed. */
  lastSuccessAt: Date | null;
  /** Persisted state from the previous run; null on the very first run for this office. */
  priorState: AlertState | null;
  /** When we last emailed an alert for this office (throttle anchor); null if never. */
  lastAlertedAt: Date | null;
  now: Date;
  thresholdMinutes: number;
  realertMinutes: number;
}

export interface HeartbeatDecision {
  stalled: boolean;
  minutesSinceSuccess: number | null;
  action: HeartbeatAction;
  nextState: AlertState;
}

/**
 * Pure silence/recovery decision. Stalled = no committed success within the threshold (or never any).
 * Throttle: alert on the transition into stalled, then at most once per realert window while still
 * stalled; emit one recovery alert on the transition back to healthy.
 */
export function decideHeartbeat(input: HeartbeatDecisionInput): HeartbeatDecision {
  const { lastSuccessAt, priorState, lastAlertedAt, now, thresholdMinutes, realertMinutes } = input;

  const minutesSinceSuccess =
    lastSuccessAt === null ? null : Math.floor((now.getTime() - lastSuccessAt.getTime()) / 60_000);

  const stalled =
    lastSuccessAt === null
      ? true
      : now.getTime() - lastSuccessAt.getTime() > thresholdMinutes * 60_000;

  if (stalled) {
    let action: HeartbeatAction;
    if (priorState !== "stalled") {
      action = "alert_stalled"; // transition into stalled → first alert
    } else {
      const dueForRealert =
        lastAlertedAt === null || now.getTime() - lastAlertedAt.getTime() >= realertMinutes * 60_000;
      action = dueForRealert ? "alert_stalled" : "none";
    }
    return { stalled: true, minutesSinceSuccess, action, nextState: "stalled" };
  }

  // healthy
  const action: HeartbeatAction = priorState === "stalled" ? "alert_recovered" : "none";
  return { stalled: false, minutesSinceSuccess, action, nextState: "ok" };
}

export interface HeartbeatEmail {
  kind: "stalled" | "recovered";
  office: string;
  lastSuccessAt: Date | null;
  minutesSinceSuccess: number | null;
  thresholdMinutes: number;
}

/** Pure email renderer — kept separate from sending so it is unit-testable without a transport. */
export function renderHeartbeatEmail(e: HeartbeatEmail): { subject: string; html: string } {
  const lastSuccessText = e.lastSuccessAt
    ? e.lastSuccessAt.toISOString()
    : "never (no successful run has ever been recorded)";
  const gapText =
    e.minutesSinceSuccess === null ? "—" : `${e.minutesSinceSuccess} min (${(e.minutesSinceSuccess / 60).toFixed(1)} h)`;

  if (e.kind === "stalled") {
    const subject = `⚠️ Bid Board sync STALLED — office ${e.office} (no success in ${e.thresholdMinutes}m)`;
    const html = `
      <h2>Bid Board → CRM sync appears stalled</h2>
      <p><strong>Office:</strong> ${e.office}</p>
      <p><strong>Last successful sync:</strong> ${lastSuccessText}</p>
      <p><strong>Time since last success:</strong> ${gapText}</p>
      <p>No committed Bid Board sync has landed in the CRM within the last ${e.thresholdMinutes} minutes.
      Because a failed ingest rolls back its own run record, this absence-of-success check is the
      authoritative signal — investigate the SyncHub push and the CRM ingest endpoint.</p>
    `;
    return { subject, html };
  }

  const subject = `✅ Bid Board sync RECOVERED — office ${e.office}`;
  const html = `
    <h2>Bid Board → CRM sync has resumed</h2>
    <p><strong>Office:</strong> ${e.office}</p>
    <p><strong>Latest successful sync:</strong> ${lastSuccessText}</p>
    <p>A committed Bid Board sync has landed again; the prior stall has cleared.</p>
  `;
  return { subject, html };
}

// ── DB I/O ──────────────────────────────────────────────────────────────────

export interface Queryable {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;
}

function validateSchemaName(name: string): string {
  if (!/^office_[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid office schema name: ${name}`);
  }
  return name;
}

/** Most recent COMMITTED-success run timestamp for an office (success OR completed_with_unmatched —
 *  both committed the ingest; only 'failed'/'processing' are excluded). null if none. */
export async function getLastCommittedSuccessAt(client: Queryable, officeSlug: string): Promise<Date | null> {
  const schema = validateSchemaName(`office_${officeSlug}`);
  const { rows } = await client.query(
    `SELECT MAX(created_at) AS last
       FROM ${schema}.bid_board_sync_runs
      WHERE status IN ('success', 'completed_with_unmatched')`
  );
  const v = rows[0]?.last ?? null;
  return v ? new Date(v) : null;
}

interface PersistedAlertState {
  state: AlertState;
  last_alerted_at: Date | null;
  last_success_at: Date | null;
}

export async function readAlertState(client: Queryable, officeSlug: string): Promise<PersistedAlertState | null> {
  const { rows } = await client.query(
    `SELECT state, last_alerted_at, last_success_at
       FROM public.bid_board_sync_alert_state WHERE office_slug = $1`,
    [officeSlug]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    state: r.state as AlertState,
    last_alerted_at: r.last_alerted_at ? new Date(r.last_alerted_at) : null,
    last_success_at: r.last_success_at ? new Date(r.last_success_at) : null,
  };
}

export async function upsertAlertState(
  client: Queryable,
  officeSlug: string,
  fields: { state: AlertState; lastAlertedAt: Date | null; lastSuccessAt: Date | null; now: Date }
): Promise<void> {
  await client.query(
    `INSERT INTO public.bid_board_sync_alert_state (office_slug, state, last_alerted_at, last_success_at, updated_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (office_slug) DO UPDATE
       SET state = EXCLUDED.state,
           last_alerted_at = EXCLUDED.last_alerted_at,
           last_success_at = EXCLUDED.last_success_at,
           updated_at = EXCLUDED.updated_at`,
    [officeSlug, fields.state, fields.lastAlertedAt, fields.lastSuccessAt, fields.now]
  );
}

export interface OfficeHeartbeatResult {
  office: string;
  decision: HeartbeatDecision;
  lastSuccessAt: Date | null;
  /** Whether an alert email was actually sent this run (false for action 'none' or a failed send). */
  sent: boolean;
}

/** Sends the rendered alert; returns true on success. Injected so the path is unit-testable and so a
 *  send failure can be observed (the throttle only advances on a successful send). */
export type AlertSender = (subject: string, html: string) => Promise<boolean>;

/**
 * Run the heartbeat for one office: read last-success + prior state, decide, send the alert (if any),
 * then persist state. Persistence happens here so the throttle/recovery state is durable across cron
 * invocations. The throttle anchor (last_alerted_at) advances ONLY when the stalled email actually
 * sends — so a transient transport failure re-alerts on the next cycle instead of going quiet for a
 * whole window. The sender is injected (tests pass a fake); a thrown sender never escapes this fn.
 */
export async function runHeartbeatForOffice(
  client: Queryable,
  opts: {
    office: string;
    now: Date;
    thresholdMinutes: number;
    realertMinutes: number;
    sendAlert?: AlertSender;
  }
): Promise<OfficeHeartbeatResult> {
  const lastSuccessAt = await getLastCommittedSuccessAt(client, opts.office);
  const prior = await readAlertState(client, opts.office);

  const decision = decideHeartbeat({
    lastSuccessAt,
    priorState: prior?.state ?? null,
    lastAlertedAt: prior?.last_alerted_at ?? null,
    now: opts.now,
    thresholdMinutes: opts.thresholdMinutes,
    realertMinutes: opts.realertMinutes,
  });

  let sent = false;
  if (decision.action !== "none" && opts.sendAlert) {
    const { subject, html } = renderHeartbeatEmail({
      kind: decision.action === "alert_recovered" ? "recovered" : "stalled",
      office: opts.office,
      lastSuccessAt,
      minutesSinceSuccess: decision.minutesSinceSuccess,
      thresholdMinutes: opts.thresholdMinutes,
    });
    try {
      sent = await opts.sendAlert(subject, html);
    } catch (err) {
      sent = false;
      console.error(`[bid-board-heartbeat] office=${opts.office} email send threw:`, err);
    }
  }

  // last_alerted_at advances only when the stalled email actually sent (so a failed send re-alerts next
  // cycle, not after a full window); recovery clears it so the next stall starts a fresh window.
  const lastAlertedAt =
    decision.action === "alert_stalled"
      ? sent
        ? opts.now
        : (prior?.last_alerted_at ?? null)
      : decision.action === "alert_recovered"
        ? null
        : (prior?.last_alerted_at ?? null);

  await upsertAlertState(client, opts.office, {
    state: decision.nextState,
    lastAlertedAt,
    lastSuccessAt,
    now: opts.now,
  });

  return { office: opts.office, decision, lastSuccessAt, sent };
}

// ── Entry point ─────────────────────────────────────────────────────────────

function recipients(): string[] {
  return (process.env.BID_BOARD_HEARTBEAT_RECIPIENTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function offices(): string[] {
  const raw = (process.env.BID_BOARD_HEARTBEAT_OFFICES ?? "dallas")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return raw.length > 0 ? raw : ["dallas"];
}

function intEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function main(now: Date = new Date()): Promise<void> {
  // Empty recipients → full no-op: the job ships inert and only activates when configured.
  const to = recipients();
  if (to.length === 0) {
    console.warn("[bid-board-heartbeat] BID_BOARD_HEARTBEAT_RECIPIENTS is empty — no-op");
    return;
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");

  const thresholdMinutes = intEnv("BID_BOARD_HEARTBEAT_SILENCE_THRESHOLD_MINUTES", 60);
  const realertMinutes = intEnv("BID_BOARD_HEARTBEAT_REALERT_MINUTES", 60);
  const officeList = offices();

  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const wrap: Queryable = { query: (text, params) => client.query(text, params as unknown[]) };
    // The sender returns true only on a successful send; runHeartbeatForOffice uses that to gate the
    // throttle anchor, and swallows a thrown transport so one office can't crash the loop.
    const sendAlert: AlertSender = (subject, html) => sendSystemEmail(to, subject, html);
    for (const office of officeList) {
      // One office failing (missing schema, transient DB error) must not sink the others.
      try {
        const { decision, lastSuccessAt, sent } = await runHeartbeatForOffice(wrap, {
          office,
          now,
          thresholdMinutes,
          realertMinutes,
          sendAlert,
        });
        console.log(
          `[bid-board-heartbeat] office=${office} stalled=${decision.stalled} action=${decision.action} ` +
            `sent=${sent} lastSuccess=${lastSuccessAt ? lastSuccessAt.toISOString() : "never"}`
        );
      } catch (err) {
        console.error(`[bid-board-heartbeat] office=${office} heartbeat check FAILED:`, err);
      }
    }
  } finally {
    await client.end();
  }
}

// Allow direct execution as compiled JS or TS source (matches daily-summary-email / usage-rollup).
if (process.argv[1] && /bid-board-sync-heartbeat\.(?:js|ts)$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
