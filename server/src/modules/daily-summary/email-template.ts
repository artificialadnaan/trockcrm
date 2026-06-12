import type { DailySummaryPayload } from "./service.js";

// Email-client-safe: tables + inline styles only (no <style>, flexbox, or JS — survives Outlook/Gmail).
// Brand: T Rock red accents (#CC0000 / #790000) on a neutral body.

const RED = "#CC0000";
const DARK = "#1e293b";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
/** NaN-safe integer — never renders "NaN"/"undefined" in the headline (same discipline as safe formatCurrency). */
function num(n: number | null | undefined): string {
  return Number.isFinite(n) ? Number(n).toLocaleString("en-US") : "—";
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

export function renderDailySummaryEmail(payload: DailySummaryPayload, pageUrl: string): string {
  const { headline, leaderboard, majorMoves, asOfLabel } = payload;
  const moverLine = headline.biggestMover
    ? `▲ ${esc(headline.biggestMover.name)} <span style="color:#64748b;">+${num(headline.biggestMover.actions)}</span>`
    : "—";

  const wonCount = majorMoves.filter((m) => m.kind === "won").length;
  const advancedCount = majorMoves.filter((m) => m.kind === "advanced").length;
  const movesTeaser =
    majorMoves.length === 0
      ? "Quiet day — no major moves"
      : `${wonCount} won · ${advancedCount} advanced today`;

  const top = leaderboard.filter((r) => r.actions > 0).slice(0, 5);
  const maxActions = top.reduce((mx, r) => Math.max(mx, r.actions), 0);
  const leaderRows = top.length
    ? top
        .map((r) => {
          const barW = maxActions > 0 ? Math.max(6, Math.round((r.actions / maxActions) * 120)) : 0;
          return `
        <tr>
          <td style="padding:4px 8px 4px 0; font:bold 13px Arial; color:${DARK}; width:18px;">${r.rank}</td>
          <td style="padding:4px 8px 4px 0; font:13px Arial; color:${DARK};">${esc(r.name)}</td>
          <td style="padding:4px 0;"><table cellpadding="0" cellspacing="0"><tr><td style="background:${RED}; height:8px; width:${barW}px; border-radius:4px; font-size:0; line-height:0;">&nbsp;</td></tr></table></td>
          <td style="padding:4px 0 4px 8px; font:bold 13px Arial; color:${DARK}; text-align:right; width:48px;">${num(r.actions)}</td>
        </tr>`;
        })
        .join("")
    : `<tr><td colspan="4" style="padding:8px 0; font:13px Arial; color:#64748b;">Quiet day — no rep activity yet.</td></tr>`;

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; background-color:#f4f4f5; font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5; padding:24px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff; border-radius:8px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,0.1);">
        <!-- Header -->
        <tr><td style="background-color:${DARK}; padding:18px 24px; border-bottom:3px solid ${RED};">
          <span style="color:#ffffff; font-size:18px; font-weight:bold; letter-spacing:0.04em;">T ROCK · DAILY PULSE</span>
          <span style="color:#94a3b8; font-size:13px; float:right; line-height:24px;">${esc(prettyDate(payload.date))} · ${esc(asOfLabel)}</span>
        </td></tr>
        <!-- Headline numbers -->
        <tr><td style="padding:20px 24px 8px;">
          <table width="100%" cellpadding="0" cellspacing="0"><tr>
            <td width="33%" style="text-align:center;">
              <div style="font:900 26px Arial; color:${DARK};">${num(headline.activeReps)}/${num(headline.totalReps)}</div>
              <div style="font:11px Arial; color:#94a3b8; text-transform:uppercase; letter-spacing:0.06em;">Active</div>
            </td>
            <td width="33%" style="text-align:center;">
              <div style="font:900 26px Arial; color:${DARK};">${num(headline.totalActions)}</div>
              <div style="font:11px Arial; color:#94a3b8; text-transform:uppercase; letter-spacing:0.06em;">Actions</div>
            </td>
            <td width="34%" style="text-align:center;">
              <div style="font:bold 16px Arial; color:${RED};">${moverLine}</div>
              <div style="font:11px Arial; color:#94a3b8; text-transform:uppercase; letter-spacing:0.06em;">Biggest mover</div>
            </td>
          </tr></table>
        </td></tr>
        <!-- Leaderboard (top 5) -->
        <tr><td style="padding:8px 24px;">
          <div style="font:bold 11px Arial; color:#94a3b8; text-transform:uppercase; letter-spacing:0.06em; padding-bottom:4px;">Leaderboard</div>
          <table width="100%" cellpadding="0" cellspacing="0">${leaderRows}</table>
        </td></tr>
        <!-- Major moves teaser -->
        <tr><td style="padding:8px 24px 4px;">
          <div style="font:bold 11px Arial; color:#94a3b8; text-transform:uppercase; letter-spacing:0.06em;">Major moves</div>
          <div style="font:14px Arial; color:${DARK}; padding-top:2px;">${esc(movesTeaser)}</div>
        </td></tr>
        <!-- CTA -->
        <tr><td style="padding:16px 24px 24px;">
          <a href="${esc(pageUrl)}" style="display:inline-block; background-color:${RED}; color:#ffffff; padding:12px 24px; border-radius:6px; text-decoration:none; font:bold 14px Arial;">See full summary →</a>
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
  const mover = payload.headline.biggestMover ? ` · ${payload.headline.biggestMover.name} leads` : "";
  return `Daily Pulse — ${prettyDate(payload.date)} (${payload.asOfLabel})${mover}`;
}
