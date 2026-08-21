// Was that a person, or was it their mail server?
//
// This is the half of open-tracking that decides whether the log is evidence or noise. Corporate email
// security — Proofpoint, Mimecast, Microsoft Defender ATP, Barracuda, Cisco — fetches every URL in an
// inbound message to scan it, within seconds of delivery. On a commercial client that is close to
// certain. So the raw access log for a healthy report looks like this:
//
//   09:02:04  Proofpoint URL Defense       <- 4 seconds after the send
//   09:02:11  BarracudaSentinel
//   14:41:02  Chrome 141 / macOS           <- the actual person, five hours later
//   14:41:03  Chrome 141 / macOS  (photo)
//   14:49:20  Chrome 141 / macOS  (pdf)
//
// Reporting "opened 5 times" from that is useless, and reporting the 09:02 hit as the client opening it
// is worse than useless: in a dispute their IT will demonstrate it was a scanner, and the rest of the
// trail goes with it.
//
// CLASSIFIED AT READ TIME, NOT AT WRITE TIME. The strongest signal a visitor was human — that they went
// on to load the photographs or download the PDF — does not exist yet when the page fetch is recorded.
// Judging at read also means this file can be improved without a backfill, which matters because the
// scanner list is a moving target.
//
// SHARED because the server assembles the audit payload and the CRM renders it. A classifier in one and
// wording in the other is how a page ends up saying "likely a person" above a row the API counted as a
// robot.

/** One recorded fetch of a share link. */
export interface WeeklyReportViewEvent {
  eventType: "page" | "pdf" | "photo";
  occurredAt: string;
  ip: string | null;
  userAgent: string | null;
}

export type WeeklyReportViewerKind = "person" | "scanner" | "unclear";

/** A group of fetches that plausibly came from one visitor in one sitting. */
export interface WeeklyReportViewSession {
  ip: string | null;
  userAgent: string | null;
  startedAt: string;
  endedAt: string;
  pageViews: number;
  photoViews: number;
  pdfDownloads: number;
  /**
   * First and last PHOTO in the sitting. Separate from `startedAt`/`endedAt` because the span that
   * distinguishes scrolling from a preload has to be measured across the photos themselves — see judge.
   */
  firstPhotoAt: string | null;
  lastPhotoAt: string | null;
  kind: WeeklyReportViewerKind;
  /** Why it was classified that way, in words a non-engineer can repeat to a client. */
  reason: string;
}

/**
 * Substrings that identify an automated fetcher, matched case-insensitively against the user agent.
 *
 * Deliberately conservative. A false SCANNER label is the dangerous direction: it hides a genuine client
 * open and would let somebody say "nobody ever looked at it" when they did. A false PERSON label only
 * overstates, and the session detail sitting beside it lets a reader judge for themselves.
 */
const SCANNER_AGENT_MARKERS = [
  "proofpoint",
  "barracuda",
  "mimecast",
  "microsoft office", // Defender's link scanner, and Outlook's own preview fetch
  "forcepoint",
  "symantec",
  "trend micro",
  "cisco",
  "ironport",
  "fireeye",
  "urldefense",
  "safelinks",
  "bot",
  "crawler",
  "spider",
  "curl",
  "wget",
  "python-requests",
  "headlesschrome",
  "slackbot",
  "whatsapp",
  "googlebot",
  "bingbot",
];

/**
 * How long an access is kept before the worker's retention sweep removes it. Adnaan's call.
 *
 * HERE, in shared, rather than beside the sweep that enforces it, because two surfaces have to agree on
 * it and they are in different packages: the worker deletes on this boundary and the audit page has to
 * know that anything older than it is missing BY DESIGN rather than absent because nobody opened the
 * report. Two copies of a number that means "how far back our evidence goes" is how a page ends up
 * confidently reporting the wrong thing about the oldest week it can still see.
 */
export const WEEKLY_REPORT_VIEW_RETENTION_MONTHS = 24;

/**
 * How long after a send a bare page fetch is treated as automated.
 *
 * A scanner runs on delivery — seconds. A person reads the email first, and even an unusually attentive
 * one takes longer than this. Not a lone verdict: a fetch inside the window that goes on to download the
 * PDF is still a person. NOT photos, though it used to say so — a scanner rendering the page pulls those
 * too, which is the whole of Codex's finding.
 */
export const WEEKLY_REPORT_SCANNER_WINDOW_SECONDS = 90;

/**
 * How long a sitting must span before loaded photos count as somebody reading rather than a preload.
 *
 * A browser's lazy-load margin fires within a second or two of the page; a person scrolls a report over
 * minutes. Two minutes is comfortably past any preload burst and comfortably inside a real read.
 */
export const WEEKLY_REPORT_READING_SPAN_SECONDS = 120;

/** Gap after which two fetches from one visitor are counted as separate sittings. */
export const WEEKLY_REPORT_VIEW_SESSION_GAP_MINUTES = 30;

export function looksLikeScannerAgent(userAgent: string | null | undefined): boolean {
  if (!userAgent) return true; // no agent at all is a script, never a browser
  const lowered = userAgent.toLowerCase();
  return SCANNER_AGENT_MARKERS.some((marker) => lowered.includes(marker));
}

/**
 * Group one report's fetches into sittings and judge each.
 *
 * @param sentAt when the report was sent, for the "arrived within seconds" signal. Null skips that test.
 */
export function summariseWeeklyReportViews(
  events: readonly WeeklyReportViewEvent[],
  sentAt: string | null,
): WeeklyReportViewSession[] {
  const ordered = [...events].sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : 1));
  const gapMs = WEEKLY_REPORT_VIEW_SESSION_GAP_MINUTES * 60_000;
  const sessions: WeeklyReportViewSession[] = [];

  for (const event of ordered) {
    // Same visitor AND still within the gap. Keyed on IP + agent rather than on IP alone: an office
    // behind one NAT address is many people, and collapsing them would report one long session where
    // there were several short ones.
    const open = sessions.find(
      (session) =>
        session.ip === event.ip &&
        session.userAgent === event.userAgent &&
        Date.parse(event.occurredAt) - Date.parse(session.endedAt) <= gapMs,
    );
    const target =
      open ??
      (sessions.push({
        ip: event.ip,
        userAgent: event.userAgent,
        startedAt: event.occurredAt,
        endedAt: event.occurredAt,
        pageViews: 0,
        photoViews: 0,
        pdfDownloads: 0,
        firstPhotoAt: null,
        lastPhotoAt: null,
        kind: "unclear",
        reason: "",
      }),
      sessions[sessions.length - 1]!);

    target.endedAt = event.occurredAt;
    if (event.eventType === "page") target.pageViews += 1;
    else if (event.eventType === "photo") {
      target.photoViews += 1;
      target.firstPhotoAt ??= event.occurredAt;
      target.lastPhotoAt = event.occurredAt;
    }
    else target.pdfDownloads += 1;
  }

  for (const session of sessions) {
    Object.assign(session, judge(session, sentAt));
  }
  // Newest first: the audit page is read to answer "did they ever look", and the most recent access is
  // the one that answers it.
  return sessions.sort((a, b) => (a.startedAt > b.startedAt ? -1 : 1));
}

function judge(
  session: WeeklyReportViewSession,
  sentAt: string | null,
): Pick<WeeklyReportViewSession, "kind" | "reason"> {
  // A SELF-IDENTIFIED SCANNER IS A SCANNER, whatever it went on to fetch — and this used to run the
  // other way round, on the theory that some corporate proxies rewrite the user agent of ordinary
  // browser traffic.
  //
  // The theory is true and the ordering was still wrong. The viewer's PDF is an ordinary link on the
  // page, and following every link is exactly what Proofpoint and its peers are FOR, so a fetch of it by
  // something calling itself Proofpoint made the audit claim a person read the report while the log
  // sitting underneath said "ProofpointURLDefense". Somebody would have read that aloud to a client.
  // Caught by Codex.
  //
  // This understates rather than overstates, which is the direction this page has to fail in: the raw
  // session is rendered beside the verdict, so a reader can see a rewritten agent for themselves and
  // judge. A confident wrong claim leaves them nothing to check.
  if (looksLikeScannerAgent(session.userAgent)) {
    return {
      kind: "scanner",
      reason: session.userAgent
        ? "The browser it reported is an email security scanner"
        : "No browser was reported, which means an automated fetch",
    };
  }

  // ENGAGEMENT, from something that did not announce itself as a robot.
  if (session.pdfDownloads > 0) {
    return { kind: "person", reason: "Downloaded the PDF, which link scanners do not do" };
  }
  // PHOTOS ARE NOT PROOF ON THEIR OWN, however much it looks like scrolling.
  //
  // The viewer emits `<img loading="lazy">`, and a browser fetches anything inside its preload margin
  // with no scroll, no click and nobody present; a headless scanner that renders the HTML pulls the
  // images for the same reason. Treating a photo request as definitive meant merely RENDERING the page
  // could become evidence that the client read the report — on the screen whose only job is to be
  // trusted in a dispute. Caught by Codex.
  //
  // What a preload cannot fake is TIME. Images inside the margin arrive in a burst at page load; a
  // person scrolling pulls them across a sitting. So photos spread over a session are somebody reading,
  // and photos in a burst are ambiguous — which is what they always were.
  if (session.photoViews > 0) {
    // ACROSS THE PHOTOS, not across the sitting. `endedAt` advances on ANY event, so one preloaded image
    // plus a page refresh two minutes later — the refresh serving its own images from cache, so no
    // second photo request at all — produced a two-minute "span" with one photo in it and read as
    // somebody scrolling. The span only means anything measured between the first photo and the last.
    // Caught by Codex.
    const spanSeconds =
      session.firstPhotoAt && session.lastPhotoAt
        ? (Date.parse(session.lastPhotoAt) - Date.parse(session.firstPhotoAt)) / 1000
        : 0;
    if (Number.isFinite(spanSeconds) && spanSeconds >= WEEKLY_REPORT_READING_SPAN_SECONDS) {
      return {
        kind: "person",
        reason:
          `Loaded ${session.photoViews} photo${session.photoViews === 1 ? "" : "s"} over ` +
          `${Math.round(spanSeconds / 60)} minute${Math.round(spanSeconds / 60) === 1 ? "" : "s"}, ` +
          `which is somebody scrolling rather than a page preloading`,
      };
    }
    return {
      kind: "unclear",
      reason:
        `Loaded ${session.photoViews} photo${session.photoViews === 1 ? "" : "s"} all at once — a ` +
        `browser preloading images looks the same as a reader`,
    };
  }

  if (sentAt) {
    const secondsAfterSend = (Date.parse(session.startedAt) - Date.parse(sentAt)) / 1000;
    if (secondsAfterSend >= 0 && secondsAfterSend <= WEEKLY_REPORT_SCANNER_WINDOW_SECONDS) {
      return {
        kind: "scanner",
        reason: `Opened ${Math.round(secondsAfterSend)}s after the email was sent, and nothing else was loaded`,
      };
    }
  }

  // A real browser, at a plausible hour, that opened the page and read no further. Genuinely ambiguous —
  // somebody who glanced and closed it looks identical to a scanner nothing here recognises, and saying
  // so is more useful than picking one.
  return {
    kind: "unclear",
    reason: "A browser opened the page but loaded nothing else",
  };
}

/** Did anybody at the client demonstrably look at this? The one-line answer the board shows. */
export function weeklyReportWasOpenedByAPerson(sessions: readonly WeeklyReportViewSession[]): boolean {
  return sessions.some((session) => session.kind === "person");
}
