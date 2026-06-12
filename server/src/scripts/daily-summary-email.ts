// Daily platform-usage summary → leadership email. Run by the dedicated `daily-summary-email` Railway
// cron at 0 22,23 * * * UTC; the job gates on actual America/Chicago time so it always lands on 5pm CT
// across the CDT/CST (DST) boundary — a fixed UTC cron would drift to 4pm/6pm in winter.
import pg from "pg";
import { BUSINESS_TIMEZONE, businessToday } from "../lib/period.js";
import { sendSystemEmail } from "../lib/resend-client.js";
import {
  DAILY_SUMMARY_OFFICE,
  DAILY_SUMMARY_SCHEMA,
  computeDailySummary,
  storeDailySummarySnapshot,
} from "../modules/daily-summary/service.js";
import { renderDailySummaryEmail, dailySummarySubject } from "../modules/daily-summary/email-template.js";

const RETENTION_DAYS = 30;

/**
 * Send only at 5:00 PM America/Chicago, Mon–Sat. DST-safe: the schedule fires at both 22:00 and 23:00
 * UTC; exactly one of those is 17:00 CT depending on the season, and Sunday is skipped on the CT
 * weekday (not UTC). Pure — unit-tested against both CDT and CST instants.
 */
export function shouldSendNow(now: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TIMEZONE,
    hour: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  const weekday = parts.find((p) => p.type === "weekday")?.value; // "Sun".."Sat"
  return hour === 17 && weekday !== "Sun";
}

function recipients(): string[] {
  return (process.env.DAILY_SUMMARY_RECIPIENTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function main(now: Date = new Date()): Promise<void> {
  if (!shouldSendNow(now)) {
    console.log(`[daily-summary] not 5pm CT (Mon–Sat) — skipping (${now.toISOString()})`);
    return;
  }
  // No recipients configured -> full no-op: no DB work, no snapshot, no token, no email. Checked
  // BEFORE compute/store so an unset DAILY_SUMMARY_RECIPIENTS never leaves an orphan snapshot or
  // consumes the day's idempotency slot.
  const to = recipients();
  if (to.length === 0) {
    console.warn("[daily-summary] DAILY_SUMMARY_RECIPIENTS is empty — no-op (no snapshot, no email)");
    return;
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");

  const date = businessToday(now); // CT date
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const wrap = { query: (text: string, params?: unknown[]) => client.query(text, params as unknown[]) };
    const payload = await computeDailySummary(wrap, DAILY_SUMMARY_SCHEMA, date);

    const expiresAt = new Date(now.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const { rawToken } = await storeDailySummarySnapshot(wrap, {
      date,
      office: DAILY_SUMMARY_OFFICE,
      asOf: now,
      payload,
      expiresAt,
    });
    if (!rawToken) {
      console.log(`[daily-summary] snapshot already exists for ${date}/${DAILY_SUMMARY_OFFICE} — already sent, skipping`);
      return;
    }

    // Durable backstop: default to the LIVE frontend (crm.trockconstruction.com is a dead NXDOMAIN that
    // would silently produce a broken CTA). If FRONTEND_URL is set it wins; if it's empty/unset we still
    // ship a working "See full summary" link.
    const baseUrl = process.env.FRONTEND_URL?.trim() || "https://trockcrm.com";
    const pageUrl = `${baseUrl}/daily-summary/${date}?token=${encodeURIComponent(rawToken)}`;
    const html = renderDailySummaryEmail(payload, pageUrl);
    const ok = await sendSystemEmail(to, dailySummarySubject(payload), html);
    console.log(`[daily-summary] ${date}: sent=${ok} to ${to.length} recipient(s)`);
  } finally {
    await client.end();
  }
}

// Allow direct execution as compiled JS or TS source (matches usage-rollup.ts).
if (process.argv[1] && /daily-summary-email\.(?:js|ts)$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
