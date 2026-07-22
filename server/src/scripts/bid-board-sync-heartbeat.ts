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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}

/** Pure email renderer — kept separate from sending so it is unit-testable without a transport. */
export function renderHeartbeatEmail(e: HeartbeatEmail): { subject: string; html: string } {
  const lastSuccessText = e.lastSuccessAt
    ? e.lastSuccessAt.toISOString()
    : "never (no successful run has ever been recorded)";
  const gapText =
    e.minutesSinceSuccess === null ? "—" : `${e.minutesSinceSuccess} min (${(e.minutesSinceSuccess / 60).toFixed(1)} h)`;
  const office = escapeHtml(e.office); // env-controlled, but escape defensively (consistency with the body fields)

  if (e.kind === "stalled") {
    const subject = `⚠️ Bid Board sync STALLED — office ${e.office} (no success in ${e.thresholdMinutes}m)`;
    const html = `
      <h2>Bid Board → CRM sync appears stalled</h2>
      <p><strong>Office:</strong> ${office}</p>
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
    <p><strong>Office:</strong> ${office}</p>
    <p><strong>Latest successful sync:</strong> ${lastSuccessText}</p>
    <p>A committed Bid Board sync has landed again; the prior stall has cleared.</p>
  `;
  return { subject, html };
}

// ── Dead-letter alert (a 202-accepted push whose async inbox job later terminalized to 'failed') ──────────

export interface DeadLetterRow {
  id: string; // inbox row id — the sweep stamps dead_letter_alerted_at on exactly these after a sent alert
  sourceFilename: string | null;
  lastError: string | null;
  idempotencyKey: string; // payload_hash — ops query /ingest/status (or the inbox row) with it
  finishedAt: Date | null;
}

const DEAD_LETTER_EMAIL_ROW_CAP = 20; // a schema-drift outage can fail every import; cap the emailed list

/**
 * Eligibility GRACE window (minutes): a row is only alerted once its `finished_at` is older than this. It
 * closes a false-positive race with the inbox's reconcileFailedButCommitted path (inbox.ts): a slow FINAL-
 * attempt import can outlive its lease so recovery terminalizes the row 'failed', and THEN the import commits
 * and recordSuccessWithRetry flips 'failed' → 'succeeded' within its bounded retry (~3s). The sweep's UNLOCKED
 * read could otherwise capture that intermediate 'failed' state and both send a false terminal-failure alert
 * AND stamp a now-'succeeded' row. The reconcile happens within seconds of the commit; 15 min is a large,
 * env-overridable safety margin over that window (a genuine dead-letter is still alerted, just one cron cycle
 * later). Values <= 0 disable the grace (alert immediately) — kept only as an escape hatch.
 */
export const DEAD_LETTER_GRACE_MINUTES_DEFAULT = 15;

export function deadLetterGraceMinutes(): number {
  const raw = Number(process.env.BID_BOARD_DEAD_LETTER_GRACE_MINUTES);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEAD_LETTER_GRACE_MINUTES_DEFAULT;
}

/** Pure renderer for the dead-letter batch email — one email per office per sweep listing the imports whose
 *  asynchronous CRM ingestion dead-lettered since the last alert. Separate from sending so it is unit-testable. */
export function renderDeadLetterEmail(e: { office: string; rows: DeadLetterRow[]; now: Date }): {
  subject: string;
  html: string;
} {
  const office = escapeHtml(e.office);
  const n = e.rows.length;
  const shown = e.rows.slice(0, DEAD_LETTER_EMAIL_ROW_CAP);
  const items = shown
    .map(
      (r) =>
        `<li><strong>${escapeHtml(r.sourceFilename ?? "(unknown file)")}</strong> — ` +
        `failed ${r.finishedAt ? r.finishedAt.toISOString() : "(time unknown)"}<br/>` +
        `error: ${escapeHtml(r.lastError ?? "(none captured)")}<br/>` +
        `idempotency key: ${escapeHtml(r.idempotencyKey)}</li>`
    )
    .join("");
  const more = n > shown.length ? `<p>…and ${n - shown.length} more.</p>` : "";
  const subject = `⚠️ Bid Board ingestion DEAD-LETTERED — office ${e.office} (${n} failed import${n === 1 ? "" : "s"})`;
  const html = `
    <h2>Bid Board → CRM ingestion reached a terminal failure</h2>
    <p><strong>Office:</strong> ${office}</p>
    <p>${n} Bid Board import${n === 1 ? "" : "s"} were durably accepted (HTTP 202) but their asynchronous
    ingestion dead-lettered after retries — the inbox row is in status <code>failed</code>. These will NOT be
    retried automatically. Query the CRM signed status endpoint with the idempotency key (or inspect the
    <code>bid_board_ingestion_inbox</code> row) for the underlying error.</p>
    <p><strong>Recovery:</strong> re-POSTing the SAME payload is a no-op — it hashes to the same idempotency
    key, hits the inbox's <code>ON CONFLICT DO NOTHING</code>, and returns the existing <code>failed</code>
    row WITHOUT enqueuing a new job. To retry, generate a FRESH scrape/payload (which produces a new
    idempotency key and its own job) or explicitly requeue the ingestion after fixing the underlying error.</p>
    <ul>${items}</ul>${more}
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

/** The office's still-UNALERTED dead-lettered inbox rows (status='failed', dead_letter_alerted_at IS NULL) that
 *  have AGED past the reconcile grace window, oldest-first. Selecting by the per-row NULL marker (not a
 *  `finished_at > watermark` cursor) means an out-of-order or same-timestamp failure commit can never be
 *  skipped. The grace filter (finished_at older than `graceMinutes`) excludes a just-'failed' row that the
 *  inbox's reconcileFailedButCommitted path may still flip back to 'succeeded' — so the sweep never sends a
 *  false terminal alert on (or stamps) a row that is about to recover. A NULL finished_at is excluded too: it
 *  has no age to compare, and a real dead-letter always stamps finished_at (markInboxFailed / recovery). */
export async function getDeadLetteredInboxRows(
  client: Queryable,
  officeSlug: string,
  graceMinutes: number = deadLetterGraceMinutes()
): Promise<DeadLetterRow[]> {
  const { rows } = await client.query(
    `SELECT id, source_filename, last_error, payload_hash, finished_at
       FROM public.bid_board_ingestion_inbox
      WHERE office_slug = $1 AND status = 'failed' AND dead_letter_alerted_at IS NULL
        AND finished_at IS NOT NULL AND finished_at < NOW() - make_interval(mins => $2::int)
      ORDER BY finished_at ASC NULLS FIRST, id ASC`,
    [officeSlug, graceMinutes]
  );
  return rows.map((r) => ({
    id: r.id as string,
    sourceFilename: r.source_filename ?? null,
    lastError: r.last_error ?? null,
    idempotencyKey: r.payload_hash as string,
    finishedAt: r.finished_at ? new Date(r.finished_at) : null,
  }));
}

/** Stamp dead_letter_alerted_at on exactly the rows just alerted (idempotent: only rows still NULL). Retires
 *  the batch so a healthy run alerts each dead-lettered row once — the per-row replacement for a timestamp
 *  watermark, immune to out-of-order commits. NOTE: the send→stamp pair is at-least-once, not exactly-once:
 *  if the send succeeds but this UPDATE fails (or the process dies before it), the rows stay NULL and the next
 *  cron re-sends the SAME batch. That is the correct safe bias for an alert — a rare duplicate on a post-send
 *  crash, never a LOST alert. The server's sendSystemEmail carries no Resend idempotency key (unlike the
 *  worker's system-email sender), so provider-side dedup isn't available on this path. */
export async function markDeadLettersAlerted(client: Queryable, ids: string[], now: Date): Promise<void> {
  if (ids.length === 0) return;
  await client.query(
    `UPDATE public.bid_board_ingestion_inbox
        SET dead_letter_alerted_at = $2
      WHERE id = ANY($1::uuid[]) AND dead_letter_alerted_at IS NULL`,
    [ids, now]
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

  // State + throttle anchor are gated on a SUCCESSFUL send so a transient transport failure re-alerts
  // next cycle instead of being lost:
  //  - stalled: advance last_alerted_at only when the email sent (else keep prior → re-alert next cycle)
  //  - recovered: only flip to 'ok' (and clear the anchor) when the recovery email sent; if it failed,
  //    stay 'stalled' so the recovery notice is retried next healthy cycle (Codex P3).
  let persistedState: AlertState = decision.nextState;
  let lastAlertedAt: Date | null;
  if (decision.action === "alert_stalled") {
    lastAlertedAt = sent ? opts.now : (prior?.last_alerted_at ?? null);
  } else if (decision.action === "alert_recovered") {
    if (sent) {
      lastAlertedAt = null;
    } else {
      persistedState = "stalled";
      lastAlertedAt = prior?.last_alerted_at ?? null;
    }
  } else {
    lastAlertedAt = prior?.last_alerted_at ?? null;
  }

  await upsertAlertState(client, opts.office, {
    state: persistedState,
    lastAlertedAt,
    lastSuccessAt,
    now: opts.now,
  });

  return { office: opts.office, decision, lastSuccessAt, sent };
}

export interface DeadLetterSweepResult {
  office: string;
  count: number; // dead-lettered rows found this sweep
  sent: boolean; // an alert email actually sent (false for none-found or a failed send)
}

/**
 * Sweep one office for still-unalerted dead-lettered ('failed') inbox rows that have AGED past the reconcile
 * grace window and email a single batch. The rows are stamped dead_letter_alerted_at ONLY on a successful send
 * (mirrors runHeartbeatForOffice's send-gated throttle), so a transient transport failure re-alerts the SAME
 * batch next run instead of dropping it, and a per-row marker means no failure is ever skipped by a timestamp
 * cursor. Delivery is AT-LEAST-ONCE: a crash between a successful send and the marker UPDATE re-sends the batch
 * next run (a rare duplicate, never a lost alert) — the correct safe bias for a monitor. Sender is injected; a
 * thrown sender never escapes this fn.
 */
export async function sweepDeadLettersForOffice(
  client: Queryable,
  opts: { office: string; now: Date; sendAlert?: AlertSender }
): Promise<DeadLetterSweepResult> {
  // Skip cleanly if the inbox table isn't provisioned in this environment yet (migration 0188 not applied) —
  // the absence-of-success heartbeat still runs; we just don't error every tick on a missing prerequisite.
  const reg = await client.query(`SELECT to_regclass('public.bid_board_ingestion_inbox') AS reg`);
  if (!reg.rows[0]?.reg) return { office: opts.office, count: 0, sent: false };

  const rows = await getDeadLetteredInboxRows(client, opts.office);
  if (rows.length === 0) return { office: opts.office, count: 0, sent: false };

  let sent = false;
  if (opts.sendAlert) {
    const { subject, html } = renderDeadLetterEmail({ office: opts.office, rows, now: opts.now });
    try {
      sent = await opts.sendAlert(subject, html);
    } catch (err) {
      sent = false;
      console.error(`[bid-board-heartbeat] office=${opts.office} dead-letter email send threw:`, err);
    }
  }

  if (sent) {
    // Stamp EVERY row in the batch (not just the displayed cap) so the whole set is retired in one shot.
    await markDeadLettersAlerted(client, rows.map((r) => r.id), opts.now);
  }
  return { office: opts.office, count: rows.length, sent };
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

// Stable 64-bit key for the whole-job advisory lock (any constant; namespaced so it can't collide).
const HEARTBEAT_ADVISORY_LOCK_KEY = 0x6268_6274; // "bbht"

export async function main(now: Date = new Date()): Promise<void> {
  // Empty recipients → full no-op: the job ships inert and only activates when configured.
  const to = recipients();
  if (to.length === 0) {
    console.warn("[bid-board-heartbeat] BID_BOARD_HEARTBEAT_RECIPIENTS is empty — no-op");
    return;
  }
  // This is a production alerting job: if recipients ARE configured but no real mail transport is, then
  // sendSystemEmail silently takes its dev/log path and reports success — a false "delivered" that would
  // advance the throttle while no email reached anyone. Fail loudly instead (Codex). Mirrors the
  // RESEND_API_KEY gate in resend-client.ts.
  if (!process.env.RESEND_API_KEY) {
    throw new Error(
      "RESEND_API_KEY is required to send heartbeat alerts (recipients are configured but there is no mail transport)"
    );
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");

  const thresholdMinutes = intEnv("BID_BOARD_HEARTBEAT_SILENCE_THRESHOLD_MINUTES", 60);
  const realertMinutes = intEnv("BID_BOARD_HEARTBEAT_REALERT_MINUTES", 60);
  const officeList = offices();

  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    // Single-writer: if a prior invocation is still running (slow cron / overlap), skip this one so two
    // runs can't read the same prior state and double-alert (CodeRabbit). Session-scoped; released on
    // disconnect in finally.
    const lock = await client.query("SELECT pg_try_advisory_lock($1) AS got", [HEARTBEAT_ADVISORY_LOCK_KEY]);
    if (!lock.rows[0]?.got) {
      console.warn("[bid-board-heartbeat] another heartbeat run holds the advisory lock — skipping");
      return;
    }

    const wrap: Queryable = { query: (text, params) => client.query(text, params as unknown[]) };
    // The sender returns true only on a successful send; runHeartbeatForOffice uses that to gate the
    // throttle anchor, and swallows a thrown transport so one office can't crash the loop.
    const sendAlert: AlertSender = (subject, html) => sendSystemEmail(to, subject, html);
    let completed = 0;
    // Track dead-letter sweeps INDEPENDENTLY of the heartbeat checks: a sweep that THROWS (migration 0190's
    // column missing, a permissions error, DB blip) counts as failed; a clean to_regclass table-absent early
    // return does NOT (the sweep ran fine, there was just nothing provisioned to sweep). If EVERY office's
    // sweep throws, the dead-letter monitor is entirely dark and must fail the cron (below) — a sweep error
    // must not otherwise stop the other offices or the heartbeat checks (each stays in its own try/catch).
    let sweepAttempts = 0;
    let sweepFailures = 0;
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
        completed++;
        console.log(
          `[bid-board-heartbeat] office=${office} stalled=${decision.stalled} action=${decision.action} ` +
            `sent=${sent} lastSuccess=${lastSuccessAt ? lastSuccessAt.toISOString() : "never"}`
        );
      } catch (err) {
        console.error(`[bid-board-heartbeat] office=${office} heartbeat check FAILED:`, err);
      }

      // Dead-letter sweep: a 202-accepted push whose async ingestion later dead-lettered is invisible to the
      // absence-of-success check above (which stays quiet while other imports still succeed), so alert on
      // newly-'failed' inbox rows. Its OWN try/catch so a sweep error can't sink the heartbeat or the loop.
      sweepAttempts++;
      try {
        const dl = await sweepDeadLettersForOffice(wrap, { office, now, sendAlert });
        if (dl.count > 0) {
          console.log(`[bid-board-heartbeat] office=${office} dead-letters=${dl.count} sent=${dl.sent}`);
        }
      } catch (err) {
        sweepFailures++;
        console.error(`[bid-board-heartbeat] office=${office} dead-letter sweep FAILED:`, err);
      }
    }
    // If EVERY office errored (state table missing, DB down, …) the monitor itself is dark — exit
    // non-zero so the cron is visibly failing instead of silently reporting success (Codex).
    if (officeList.length > 0 && completed === 0) {
      throw new Error(`heartbeat check failed for ALL ${officeList.length} office(s) — see logs above`);
    }
    // Same guard for the dead-letter sweep: if EVERY office's sweep THREW (e.g. migration 0190 not applied so
    // the column is missing, or a permissions error), the dead-letter monitor is silently dark. Fail the cron
    // so the outage is visible rather than a false exit-0 (Codex). A clean table-absent early return isn't a
    // failure, so a not-yet-provisioned inbox alone won't trip this.
    if (sweepAttempts > 0 && sweepFailures === sweepAttempts) {
      throw new Error(`dead-letter sweep failed for ALL ${sweepAttempts} office(s) — see logs above`);
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
