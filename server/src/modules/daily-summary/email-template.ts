import type { DailySummaryPayload, LeaderRow, RepBreakdown, WonDeal } from "./service.js";

// Email-client-safe: tables + inline styles only (no <style>, flexbox, or JS — survives Outlook/Gmail).
// Brand: T Rock red accents (#CC0000 / #790000) on a neutral body.

const RED = "#CC0000";
const DARK = "#1e293b";
const MUTE = "#64748b";

const WON_EMAIL_CAP = 5;
const ADVANCED_EMAIL_CAP = 4;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
/** NaN-safe integer — never renders "NaN"/"undefined" in the headline (same discipline as safe formatCurrency). */
function num(n: number | null | undefined): string {
  return Number.isFinite(n) ? Number(n).toLocaleString("en-US") : "—";
}
/** Full dollars, NaN-safe: $186,000. */
function usdFull(n: number | null | undefined): string {
  return Number.isFinite(n) ? `$${Math.round(Number(n)).toLocaleString("en-US")}` : "$0";
}
/** Compact dollars for headers, NaN-safe: $312K / $1.2M. */
function usdCompact(n: number | null | undefined): string {
  if (!Number.isFinite(n)) return "$0";
  const v = Math.round(Number(n));
  if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(Math.abs(v) >= 10_000_000 ? 0 : 1)}M`;
  if (Math.abs(v) >= 1_000) return `$${Math.round(v / 1_000)}K`;
  return `$${v}`;
}

/** Pretty date for the header, e.g. "Fri, Jun 12" — from the CT date string (no tz conversion). */
function prettyDate(iso: string): string {
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${WEEKDAYS[wd]}, ${MONTHS[m - 1]} ${d}`;
}

/** The day's Won total — summed from the SAME array the rows render from (header can't drift from items). */
function wonTotal(won: WonDeal[]): number {
  return won.reduce((s, d) => s + (Number.isFinite(d.value) ? d.value : 0), 0);
}

/** "minutes where present, — where absent, never 0m": null/0/negative -> "—" (guarded at render time so
 *  the invariant holds even if upstream flooring ever regresses); otherwise the minutes. */
function minutesLabel(activeMinutes: number | null): string {
  if (activeMinutes == null || !Number.isFinite(activeMinutes) || activeMinutes <= 0) return "—";
  return `${num(activeMinutes)}m`;
}

// Count-aware [singular, plural] labels for every breakdown bucket — structural keys and activity types.
// "created" is a count-invariant past participle; the rest read correctly at 1 ("1 note", not "1 notes").
const BREAKDOWN_LABELS: Record<string, readonly [string, string]> = {
  created: ["created", "created"],
  moves: ["move", "moves"],
  edits: ["edit", "edits"],
  uploads: ["upload", "uploads"],
  reports: ["report", "reports"],
  email: ["email", "emails"],
  note: ["note", "notes"],
  call: ["call", "calls"],
  meeting: ["meeting", "meetings"],
  voicemail: ["voicemail", "voicemails"],
  text: ["text", "texts"],
  sms: ["text", "texts"],
  task_completed: ["task completed", "tasks completed"],
};

/** Count-correct label for a breakdown bucket. Unknown activity types are humanized (no naive "+s" that
 *  would yield "task completeds") and shown as-is for both counts — readable beats wrong. */
function breakdownLabel(key: string, n: number): string {
  const pair = BREAKDOWN_LABELS[key];
  if (pair) return n === 1 ? pair[0] : pair[1];
  return key.replace(/_/g, " ");
}

/** Team time-spent: 0 -> "—" (no sessions); < 1h -> minutes; otherwise hours to one decimal. */
function hoursLabel(totalMinutes: number | null | undefined): string {
  if (!Number.isFinite(totalMinutes) || Number(totalMinutes) <= 0) return "—";
  const m = Number(totalMinutes);
  return m < 60 ? `${num(m)}m` : `${(m / 60).toFixed(1)}h`;
}

/** Non-zero buckets only, highest-signal first, top 4 — the breakdown IS the value, not a bar. Activity
 *  types (email/call/meeting/…) are all included so a calls-heavy rep never shows an empty breakdown. */
function breakdownLine(b: RepBreakdown): string {
  const acts = Object.entries(b.activities)
    .filter(([, n]) => n > 0)
    .sort((a, c) => c[1] - a[1] || a[0].localeCompare(c[0]))
    .map(([type, n]) => [n, type] as [number, string]);
  const parts: [number, string][] = [
    [b.created, "created"],
    [b.stageMoves, "moves"],
    ...acts,
    [b.edits, "edits"],
    [b.uploads, "uploads"],
    [b.reports, "reports"],
  ];
  const nz = parts.filter(([n]) => n > 0).slice(0, 4);
  return nz.length ? nz.map(([n, key]) => `${num(n)} ${breakdownLabel(key, n)}`).join(", ") : "—";
}

function sectionLabel(text: string, rightNote?: string): string {
  return `
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font:bold 11px Arial; color:#94a3b8; text-transform:uppercase; letter-spacing:0.06em;">${esc(text)}</td>
      ${rightNote ? `<td style="text-align:right; font:bold 12px Arial; color:${DARK};">${esc(rightNote)}</td>` : ""}
    </tr></table>`;
}

function wonRows(won: WonDeal[]): string {
  if (won.length === 0) return "";
  const shown = won.slice(0, WON_EMAIL_CAP);
  const rows = shown
    .map(
      (d) => `
      <tr>
        <td style="padding:3px 8px 3px 0; font:13px Arial; color:${DARK};">
          <span style="color:#16a34a;">&#9679;</span> ${esc(d.dealName)}
        </td>
        <td style="padding:3px 8px; font:13px Arial; color:${MUTE};">${esc(d.repName)}</td>
        <td style="padding:3px 0; font:bold 13px Arial; color:${DARK}; text-align:right; white-space:nowrap;">${esc(usdFull(d.value))}</td>
      </tr>`,
    )
    .join("");
  const more =
    won.length > WON_EMAIL_CAP
      ? `<tr><td colspan="3" style="padding:4px 0 0; font:12px Arial; color:${RED};">+${won.length - WON_EMAIL_CAP} more &rarr; full list on the page</td></tr>`
      : "";
  return `<table width="100%" cellpadding="0" cellspacing="0">${rows}${more}</table>`;
}

function advancedRows(moves: DailySummaryPayload["advancedToday"]): string {
  if (moves.length === 0) return "";
  const shown = moves.slice(0, ADVANCED_EMAIL_CAP);
  const rows = shown
    .map(
      (m) => `
      <tr>
        <td style="padding:3px 8px 3px 0; font:13px Arial; color:${DARK}; white-space:nowrap;">&#9656; ${esc(m.dealName)}</td>
        <td style="padding:3px 8px; font:13px Arial; color:${MUTE};">${esc(m.fromStage ?? "—")} &rarr; ${esc(m.toStage ?? "—")}</td>
        <td style="padding:3px 0; font:13px Arial; color:${MUTE}; text-align:right;">${esc(m.repName)}</td>
      </tr>`,
    )
    .join("");
  const more =
    moves.length > ADVANCED_EMAIL_CAP
      ? `<tr><td colspan="3" style="padding:4px 0 0; font:12px Arial; color:${RED};">+${moves.length - ADVANCED_EMAIL_CAP} more &rarr; full list on the page</td></tr>`
      : "";
  return `<table width="100%" cellpadding="0" cellspacing="0">${rows}${more}</table>`;
}

function leaderRows(leaderboard: LeaderRow[]): string {
  const top = leaderboard.filter((r) => r.actions > 0).slice(0, 5);
  if (top.length === 0) {
    return `<tr><td style="padding:8px 0; font:13px Arial; color:${MUTE};">Quiet day — no rep activity yet.</td></tr>`;
  }
  return top
    .map(
      (r) => `
      <tr>
        <td style="padding:5px 8px 5px 0; font:bold 13px Arial; color:${DARK}; width:16px; vertical-align:top;">${r.rank}</td>
        <td style="padding:5px 0;">
          <div style="font:bold 13px Arial; color:${DARK};">${esc(r.name)} <span style="color:#94a3b8; font-weight:normal;">&middot; ${esc(minutesLabel(r.activeMinutes))}</span></div>
          <div style="font:12px Arial; color:${MUTE};">${esc(breakdownLine(r.breakdown))}</div>
        </td>
        <td style="padding:5px 0; font:bold 13px Arial; color:${DARK}; text-align:right; width:48px; vertical-align:top;">${num(r.actions)}</td>
      </tr>`,
    )
    .join("");
}

export function renderDailySummaryEmail(payload: DailySummaryPayload, pageUrl: string): string {
  const { headline, leaderboard, wonToday, advancedToday, asOfLabel } = payload;
  const moverLine = headline.biggestMover
    ? `&#9650; ${esc(headline.biggestMover.name)} <span style="color:#64748b;">+${num(headline.biggestMover.actions)}</span>`
    : "—";

  const wonCount = wonToday.length;
  const advancedCount = advancedToday.length;
  // Quiet-day teaser preserves the exact "Quiet day — no major moves" copy used elsewhere.
  const quietMoves = wonCount === 0 && advancedCount === 0;

  const wonSection =
    wonCount > 0
      ? `
        <tr><td style="padding:14px 24px 4px;">
          ${sectionLabel("Won today", `${wonCount} · ${usdFull(wonTotal(wonToday))}`)}
        </td></tr>
        <tr><td style="padding:2px 24px 8px;">${wonRows(wonToday)}</td></tr>`
      : "";

  const advancedSection =
    advancedCount > 0
      ? `
        <tr><td style="padding:8px 24px 4px; border-top:1px solid #f1f5f9;">
          ${sectionLabel("Advanced today", `${advancedCount} ${advancedCount === 1 ? "move" : "moves"}`)}
        </td></tr>
        <tr><td style="padding:2px 24px 8px;">${advancedRows(advancedToday)}</td></tr>`
      : "";

  const quietSection = quietMoves
    ? `
        <tr><td style="padding:14px 24px 8px;">
          ${sectionLabel("Today")}
          <div style="font:14px Arial; color:${DARK}; padding-top:4px;">Quiet day — no major moves</div>
        </td></tr>`
    : "";

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; background-color:#f4f4f5; font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5; padding:24px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff; border-radius:8px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,0.1);">
        <!-- Header -->
        <tr><td style="background-color:${DARK}; padding:18px 24px; border-bottom:3px solid ${RED};">
          <span style="color:#ffffff; font-size:18px; font-weight:bold; letter-spacing:0.04em;">T ROCK &middot; DAILY PULSE</span>
          <span style="color:#94a3b8; font-size:13px; float:right; line-height:24px;">${esc(prettyDate(payload.date))} &middot; ${esc(asOfLabel)}</span>
        </td></tr>
        <!-- Headline numbers: activity (reps / time / actions) + the biggest mover -->
        <tr><td style="padding:20px 24px 8px;">
          <table width="100%" cellpadding="0" cellspacing="0"><tr>
            <td width="22%" style="text-align:center;">
              <div style="font:900 24px Arial; color:${DARK};">${num(headline.activeReps)}/${num(headline.totalReps)}</div>
              <div style="font:11px Arial; color:#94a3b8; text-transform:uppercase; letter-spacing:0.06em;">Active</div>
            </td>
            <td width="22%" style="text-align:center;">
              <div style="font:900 24px Arial; color:${DARK};">${esc(hoursLabel(headline.totalActiveMinutes))}</div>
              <div style="font:11px Arial; color:#94a3b8; text-transform:uppercase; letter-spacing:0.06em;">Time</div>
            </td>
            <td width="22%" style="text-align:center;">
              <div style="font:900 24px Arial; color:${DARK};">${num(headline.totalActions)}</div>
              <div style="font:11px Arial; color:#94a3b8; text-transform:uppercase; letter-spacing:0.06em;">Actions</div>
            </td>
            <td width="34%" style="text-align:center;">
              <div style="font:bold 15px Arial; color:${RED};">${moverLine}</div>
              <div style="font:11px Arial; color:#94a3b8; text-transform:uppercase; letter-spacing:0.06em;">Biggest mover</div>
            </td>
          </tr></table>
        </td></tr>
        ${wonSection}
        ${advancedSection}
        ${quietSection}
        <!-- Leaderboard (top 5) — the breakdown is the value, not a bar -->
        <tr><td style="padding:10px 24px 4px; border-top:1px solid #f1f5f9;">
          ${sectionLabel("Who moved it")}
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:4px;">${leaderRows(leaderboard)}</table>
        </td></tr>
        <!-- CTA -->
        <tr><td style="padding:16px 24px 24px;">
          <a href="${esc(pageUrl)}" style="display:inline-block; background-color:${RED}; color:#ffffff; padding:12px 24px; border-radius:6px; text-decoration:none; font:bold 14px Arial;">See full summary &rarr;</a>
        </td></tr>
        <!-- Footer -->
        <tr><td style="padding:14px 24px; border-top:1px solid #e2e8f0; color:#94a3b8; font-size:12px;">
          Snapshot ${esc(asOfLabel)} — a mid-day check-in, not a complete daily total. Automated from T Rock CRM; do not reply.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export function dailySummarySubject(payload: DailySummaryPayload): string {
  const head = `Daily Pulse — ${prettyDate(payload.date)} (${payload.asOfLabel})`;
  if (payload.wonToday.length > 0) {
    return `${head} · ${payload.wonToday.length} won, ${usdCompact(wonTotal(payload.wonToday))}`;
  }
  const mover = payload.headline.biggestMover ? ` · ${payload.headline.biggestMover.name} leads` : "";
  return `${head}${mover}`;
}
