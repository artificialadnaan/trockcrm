// Every access to a client's weekly-report link, grouped into sittings.
//
// "We never received that report" is a claim the CRM could not previously answer at all. It knew the
// message was composed, that the provider accepted it, and what the provider said afterwards — and then
// nothing. This turns the raw access rows into something a person can read and quote.
//
// IT GROUPS. IT DOES NOT JUDGE, and that is a deliberate retreat from where this file started.
//
// The first version classified each sitting as a person, a scanner, or unclear. The motivation was real:
// corporate email security — Proofpoint, Mimecast, Defender, Barracuda — fetches every URL in an inbound
// message within seconds of delivery, so on a commercial client the log for a healthy report looks like
//
//   09:02:04  Proofpoint URL Defense       <- 4 seconds after the send
//   09:02:11  BarracudaSentinel
//   14:41:02  Chrome 141 / macOS           <- the actual person, five hours later
//   14:41:03  Chrome 141 / macOS  (photo)
//   14:49:20  Chrome 141 / macOS  (pdf)
//
// and "opened 5 times" is a useless summary of it. But every rule that separates the two turned out to
// have a counterexample, and review found them one after another:
//
//   • a photo fetch looked like scrolling — until `<img loading="lazy">` turned out to preload images
//     with nobody in the room, and a headless renderer to pull them for the same reason
//   • photos spread over time looked like reading — until one cached refresh stretched a single image
//     into a two-minute "span"
//   • a PDF download looked decisive — until a scanner followed the link, because following every link
//     is precisely what those products are for
//   • the agent string looked authoritative — except corporate proxies rewrite them
//
// Each fix was correct and each produced the next case, because the question is underdetermined: HTTP
// requests do not carry intent, and a verdict asserts one. On any other screen a wrong guess is
// cosmetic. On this one it gets quoted to a client, and being shown that our "person" was a datacentre
// discredits the whole record — including the parts that are solid.
//
// So the sittings carry the FACTS: when, from where, what device, what was fetched. Whoever reads them
// decides. That is the artefact a dispute actually needs, and it is one nothing can refute.
//
// SHARED because the server assembles the audit payload and the CRM renders it.

/** One recorded fetch of a share link. */
export interface WeeklyReportViewEvent {
  eventType: "page" | "pdf" | "photo";
  occurredAt: string;
  ip: string | null;
  userAgent: string | null;
  /** The referring page's ORIGIN only — the path and query are discarded at write time. */
  referrerOrigin: string | null;
}

/**
 * A group of fetches that plausibly came from one visitor in one sitting.
 *
 * Every field is an observation. There is no derived verdict, on purpose — see the note above.
 */
export interface WeeklyReportViewSession {
  ip: string | null;
  userAgent: string | null;
  startedAt: string;
  endedAt: string;
  pageViews: number;
  photoViews: number;
  pdfDownloads: number;
  /**
   * Where the sitting came from, first one seen. Stored precisely to distinguish "reached this from
   * Gmail" from "reached it from a Teams message", so it has to reach the page — data kept for a
   * purpose it never serves is data that should not have been kept.
   */
  referrerOrigin: string | null;
}

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
 * Gap after which two fetches from one visitor are counted as separate sittings.
 *
 * A GROUPING choice, not a judgement. It decides how rows are arranged for a reader and nothing
 * concludes anything from the count — notably, two sittings are not two people, since the same person
 * returning after lunch produces exactly that.
 */
export const WEEKLY_REPORT_VIEW_SESSION_GAP_MINUTES = 30;

/** Group one report's fetches into sittings, newest first. */
export function summariseWeeklyReportViews(
  events: readonly WeeklyReportViewEvent[],
): WeeklyReportViewSession[] {
  const ordered = [...events].sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : 1));
  const gapMs = WEEKLY_REPORT_VIEW_SESSION_GAP_MINUTES * 60_000;
  const sessions: WeeklyReportViewSession[] = [];

  for (const event of ordered) {
    // Same visitor AND still within the gap. Keyed on IP + agent rather than on IP alone: an office
    // behind one NAT address is many people, and collapsing them would report one long sitting where
    // there were several short ones.
    //
    // AN UNIDENTIFIED FETCH JOINS NOTHING. Two requests with no usable address and no user agent are not
    // evidence of one visitor — they are two things we could not identify, and `null === null` merged
    // them into a single sitting that the page then presented as one person's activity. A test here
    // asserted that merge as correct. Caught by Codex.
    const identified = event.ip != null || event.userAgent != null;
    const open = identified
      ? sessions.find(
          (session) =>
            session.ip === event.ip &&
            session.userAgent === event.userAgent &&
            Date.parse(event.occurredAt) - Date.parse(session.endedAt) <= gapMs,
        )
      : undefined;
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
        referrerOrigin: event.referrerOrigin,
      }),
      sessions[sessions.length - 1]!);

    target.endedAt = event.occurredAt;
    target.referrerOrigin ??= event.referrerOrigin;
    if (event.eventType === "page") target.pageViews += 1;
    else if (event.eventType === "photo") target.photoViews += 1;
    else target.pdfDownloads += 1;
  }

  // Newest first, BY LAST FETCH rather than by first. A sitting that ran 13:00–15:00 is more recent
  // activity than one that started and finished at 14:00, and ordering on `startedAt` buried the longer
  // one underneath — contradicting, in the one place a reader looks first, the promise this line makes.
  // Caught by Codex.
  return sessions.sort((a, b) => (a.endedAt > b.endedAt ? -1 : 1));
}
