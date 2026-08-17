import type { WeeklyReportPdfContact } from "./pdf.js";
import type { WeeklyReportView } from "./report-view.js";

// The page behind the client's link: server-rendered HTML, no JavaScript, no build step.
//
// A single self-contained document is the right shape here for reasons that are not laziness. The audience
// opens it once, on a phone, from an email — a client-side app would mean a bundle, a fetch, a spinner and
// a blank page for anyone whose corporate mail client strips scripts. It is also served by the API rather
// than the SPA, so there is no client build to reach in the first place.
//
// Every interpolated value goes through escapeHtml. All of it — property names, captions, the
// superintendent's free text — is user-authored and this page is the one surface in the feature that faces
// outside the company.
//
// The styles below deliberately do NOT draw on the CRM's design system (DESIGN.md / client tokens). They
// reproduce the PRINTED report the client already receives — the same red band, the same black property
// plate, the same section order — so the page and the attached PDF read as one document. There is also no
// mechanism to share those tokens here: this file ships as a literal string from the API container, with no
// build step and nothing imported from client/.

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: unknown): string {
  if (value == null) return "";
  return String(value).replace(/[&<>"']/g, (char) => ESCAPES[char]!);
}

/**
 * The shared page shell. `noindex` is a META TAG *and* an X-Robots-Tag header on the route: the header
 * covers the PDF and the photo bytes, which carry no HTML to put a meta tag in, and a crawler that finds
 * one client's link in a forwarded email must not put a construction schedule into a search index.
 */
function documentShell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
${body}
</body>
</html>`;
}

const STYLES = `
:root {
  --red: #C1272D;
  --ink: #14181F;
  --muted: #5B6675;
  --line: #E2E5EA;
  --surface: #FFFFFF;
  --page: #F4F5F7;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 0 0 48px;
  background: var(--page);
  color: var(--ink);
  font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  -webkit-text-size-adjust: 100%;
}
.wrap { max-width: 820px; margin: 0 auto; padding: 0 16px; }
.band {
  background: var(--red);
  color: #fff;
  padding: 20px 16px;
}
.band .wrap { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 16px; }
.band h1 { margin: 0; font-size: 22px; line-height: 1.25; font-weight: 700; }
.band .week { font-size: 15px; opacity: 0.92; }
.property {
  background: #111;
  color: #fff;
  padding: 14px 16px;
}
.property .label { font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.72; }
.property .value { font-size: 19px; font-weight: 600; margin-top: 2px; word-break: break-word; }
.card {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 16px;
  margin-top: 16px;
}
.card h2 {
  margin: 0 0 10px;
  font-size: 15px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted);
}
.prose { white-space: pre-wrap; word-wrap: break-word; margin: 0; font-size: 15px; }
.empty { color: var(--muted); font-style: italic; }
.rows { display: grid; gap: 8px; }
.row { display: flex; justify-content: space-between; gap: 16px; font-size: 15px; }
.row .k { color: var(--muted); }
.row .v { font-weight: 600; text-align: right; }
.people { display: grid; gap: 6px; }
.person { display: flex; gap: 10px; font-size: 15px; }
.person .k { color: var(--muted); min-width: 58px; font-size: 13px; padding-top: 2px; }
.bar-label { font-size: 13px; color: var(--muted); margin-bottom: 4px; }
.bar { height: 22px; border-radius: 3px; color: #fff; font-size: 13px; font-weight: 600;
       display: flex; align-items: center; padding: 0 10px; min-width: 42px; }
.bar.projected { background: #111; }
.bar.remaining { background: var(--red); }
.bar-track { margin-bottom: 12px; }
.photos { display: grid; grid-template-columns: 1fr; gap: 14px; }
.photo { border: 1px solid var(--line); border-radius: 10px; overflow: hidden; background: var(--surface); }
.photo img { display: block; width: 100%; height: auto; background: #EDEFF2; }
.photo figcaption { padding: 10px 12px; font-size: 14px; color: var(--ink); }
.actions { margin-top: 20px; }
.btn {
  display: inline-block; background: var(--red); color: #fff; text-decoration: none;
  padding: 13px 22px; border-radius: 8px; font-weight: 600; font-size: 16px;
}
.notice {
  margin-top: 16px; padding: 12px 14px; border-radius: 8px;
  background: #FFF4E5; border: 1px solid #F0D3A5; font-size: 15px;
}
.foot { margin-top: 24px; font-size: 13px; color: var(--muted); }
.stack { margin-top: 20px; }
@media (min-width: 700px) {
  .band h1 { font-size: 27px; }
  .grid2 { display: grid; grid-template-columns: 1.6fr 1fr; gap: 16px; align-items: start; }
  .grid2 > .card { margin-top: 16px; }
  .photos { grid-template-columns: repeat(3, 1fr); }
}
`;

function section(title: string, body: string | null): string {
  const content = body?.trim()
    ? `<p class="prose">${escapeHtml(body.trim())}</p>`
    : `<p class="prose empty">Nothing reported this week.</p>`;
  return `<section class="card"><h2>${escapeHtml(title)}</h2>${content}</section>`;
}

function peopleList(contacts: WeeklyReportPdfContact[]): string {
  const filled = contacts.filter((contact) => contact.name?.trim());
  // Blank roles are omitted rather than printed empty: RM and CM are routinely unstaffed, and four rows of
  // nothing reads as missing data instead of as a team that simply has two people on it.
  if (filled.length === 0) return `<p class="prose empty">Not recorded.</p>`;
  return `<div class="people">${filled
    .map(
      (contact) =>
        `<div class="person"><span class="k">${escapeHtml(contact.label)}</span><span>${escapeHtml(
          contact.name,
        )}</span></div>`,
    )
    .join("")}</div>`;
}

function durationBars(duration: { projectedWeeks: number | null; remainingWeeks: number | null }): string {
  const projected = duration.projectedWeeks;
  const remaining = duration.remainingWeeks;
  // Same rule as the PDF: with no projected duration to scale against, the remaining bar runs full width.
  // A short bar would read as "nearly done" when the honest answer is "we do not know".
  const remainingPct =
    projected && projected > 0 && remaining != null
      ? Math.max(6, Math.round((Math.min(remaining, projected) / projected) * 100))
      : 100;
  const label = (value: number | null) => escapeHtml(value == null ? "—" : String(value));
  return `
    <div class="bar-track">
      <div class="bar-label">Projected</div>
      <div class="bar projected" style="width:100%">${label(projected)}</div>
    </div>
    <div class="bar-track">
      <div class="bar-label">Remaining</div>
      <div class="bar remaining" style="width:${remainingPct}%">${label(remaining)}</div>
    </div>`;
}

export interface WeeklyReportViewerHtmlInput {
  view: WeeklyReportView;
  /** Same-origin URL for one photo's bytes. The R2 key is never exposed — it embeds the deal number. */
  photoUrl: (fileId: string) => string;
  pdfUrl: string;
  /** Set when a correction superseded this version; the original link must keep working and say so. */
  supersededNotice?: string | null;
}

export function renderWeeklyReportViewerHtml(input: WeeklyReportViewerHtmlInput): string {
  const { pdf } = input.view;
  const schedule: Array<[string, string]> = [
    ["Contract Date", pdf.schedule.contractDate],
    ["Project Start Date", pdf.schedule.projectStartDate],
    ["Project Completion Date", pdf.schedule.projectCompletionDate],
    ["Current Project Completion %", pdf.schedule.completionPercent],
    ["Total Project Weather Delays", pdf.schedule.weatherDelayDays],
  ];

  const photos = pdf.photos.length
    ? `<section class="card"><h2>Weekly Progress Photos</h2><div class="photos">${pdf.photos
        .map(
          (photo) =>
            `<figure class="photo"><img src="${escapeHtml(input.photoUrl(photo.fileId))}" alt="${escapeHtml(
              photo.caption ?? "Progress photo",
            )}" loading="lazy">${
              photo.caption?.trim() ? `<figcaption>${escapeHtml(photo.caption.trim())}</figcaption>` : ""
            }</figure>`,
        )
        .join("")}</div></section>`
    : "";

  const body = `
<header class="band"><div class="wrap">
  <h1>Weekly Progress Summary</h1>
  <span class="week">Week of ${escapeHtml(pdf.weekOfLabel)}</span>
</div></header>
<div class="property"><div class="wrap">
  <div class="label">Property Name</div>
  <div class="value">${escapeHtml(pdf.propertyName)}</div>
</div></div>
<main class="wrap">
  ${input.supersededNotice ? `<div class="notice">${escapeHtml(input.supersededNotice)}</div>` : ""}
  ${pdf.version > 1 ? `<div class="notice">This is revision ${escapeHtml(String(pdf.version))} of this week's report.</div>` : ""}
  <div class="grid2">
    <div>
      ${section("Work Completed / In-Progress", pdf.workCompleted)}
      ${section("Next Week Look Ahead", pdf.nextWeekLookAhead)}
      ${section("Issues / Concerns", pdf.issuesConcerns)}
    </div>
    <div>
      <section class="card">
        <h2>Client</h2>
        <p class="prose">${pdf.clientName ? escapeHtml(pdf.clientName) : '<span class="empty">Not recorded.</span>'}</p>
      </section>
      <section class="card"><h2>Client Team</h2>${peopleList(pdf.clientTeam)}</section>
      <section class="card"><h2>T-Rock Project Team</h2>${peopleList(pdf.trockTeam)}</section>
    </div>
  </div>
  <section class="card">
    <h2>Project Schedule</h2>
    <div class="rows">${schedule
      .map(
        ([key, value]) =>
          `<div class="row"><span class="k">${escapeHtml(key)}</span><span class="v">${escapeHtml(value)}</span></div>`,
      )
      .join("")}</div>
  </section>
  <section class="card">
    <h2>Project Duration (weeks)</h2>
    ${durationBars(pdf.duration)}
  </section>
  ${photos}
  <div class="actions"><a class="btn" href="${escapeHtml(input.pdfUrl)}">Download PDF</a></div>
  <p class="foot">T-Rock Construction${
    input.view.trockPm.name ? ` &middot; ${escapeHtml(input.view.trockPm.name)}` : ""
  }</p>
</main>`;

  return documentShell(`${pdf.propertyName} — Weekly Progress Summary`, body);
}

export type WeeklyReportUnavailableReason = "expired" | "revoked" | "withdrawn" | "unavailable" | "unknown";

export interface WeeklyReportUnavailableInput {
  reason: WeeklyReportUnavailableReason;
  /** The T-Rock PM to ask for a fresh link. Null when the token resolved to nothing at all. */
  contact: { name: string | null; email: string | null } | null;
  propertyName?: string | null;
}

const UNAVAILABLE_HEADLINES: Record<WeeklyReportUnavailableReason, string> = {
  expired: "This report link has expired",
  revoked: "This report link is no longer active",
  withdrawn: "This report is being updated",
  unavailable: "We can’t load this report right now",
  unknown: "We couldn’t find that report link",
};

const UNAVAILABLE_BODIES: Record<WeeklyReportUnavailableReason, string> = {
  expired: "Weekly report links stay active for 180 days. This one has passed that window.",
  revoked: "This link was turned off by the project team, usually because a corrected version was issued.",
  // The report went back to the field for revision after this link was created. Deliberately vague about
  // WHY — "your superintendent is rewriting it" is an internal detail — but honest that the link is fine
  // and it is the report that moved.
  withdrawn: "The project team has pulled this week's report back for revision. Your link will work again once it is re-issued.",
  // Distinct from "not found" on purpose: telling somebody with a perfectly good link that it does not
  // exist sends them chasing a replacement that will behave exactly the same way.
  unavailable: "Something went wrong on our side. Your link is fine — please try again in a few minutes.",
  unknown: "The link may have been mistyped, or only part of it was copied from the email.",
};

/**
 * The dead-link page — and the reason resolveWeeklyReportToken deliberately does not filter expired and
 * revoked rows out.
 *
 * The client is holding a link they were sent; a stack trace, a raw 404, or "Not found" tells them nothing
 * they can act on. Naming the T-Rock PM and their email turns it into a next step. When the token resolved
 * to nothing there IS no PM to name, and inventing a support address would be worse than saying so.
 */
export function renderWeeklyReportUnavailableHtml(input: WeeklyReportUnavailableInput): string {
  const contact = input.contact;
  const contactBlock = contact?.email
    ? `<p class="prose">For a current link, contact ${escapeHtml(
        contact.name ?? "your T-Rock project manager",
      )} at <a href="mailto:${escapeHtml(contact.email)}">${escapeHtml(contact.email)}</a>.</p>`
    : contact?.name
      ? `<p class="prose">For a current link, contact your T-Rock project manager, ${escapeHtml(contact.name)}.</p>`
      : `<p class="prose">Please reply to the email this link came from and the project team will send a current one.</p>`;

  const body = `
<header class="band"><div class="wrap"><h1>${escapeHtml(UNAVAILABLE_HEADLINES[input.reason])}</h1></div></header>
<main class="wrap">
  <section class="card">
    ${input.propertyName ? `<h2>${escapeHtml(input.propertyName)}</h2>` : ""}
    <p class="prose">${escapeHtml(UNAVAILABLE_BODIES[input.reason])}</p>
    <div class="stack">${contactBlock}</div>
  </section>
  <p class="foot">T-Rock Construction</p>
</main>`;

  return documentShell(UNAVAILABLE_HEADLINES[input.reason], body);
}
