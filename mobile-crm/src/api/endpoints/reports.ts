import type { Fetcher } from "./auth";

/**
 * The Monday Showcase, on a phone.
 *
 * WHY THIS REPORT AND NOT THE OTHER FORTY. `server/src/modules/reports/routes.ts` exposes dozens of
 * report endpoints, and almost all of them are `requireDirector` and shaped for a wide table. This one
 * is `requireAnyRole`, answers in ONE request with no pagination, and its payload is already a set of
 * headline numbers rather than rows — which is the only shape that survives a 390pt screen.
 *
 * A LOAD-BEARING FACT ABOUT THE WEB VERSION: A1/A2/A3/HERO/B1/B2/B3/B4 were never separate reports.
 * They are client-side render slices of this single payload, chosen with a variant picker. So a phone
 * client is not "missing" the other variants — it is another slice, and the right one is the part a rep
 * reads standing up.
 *
 * The response is wrapped: `{ data: MondayShowcaseData }`. Unwrapped here so callers get the payload.
 */

/** to_date | completed | mtd | ytd — mirrors WeekMode in server/src/lib/period.ts:14. */
export type WeekMode = "to_date" | "completed" | "mtd" | "ytd";

/**
 * A money figure AND the rule that produced it.
 *
 * `basisLabel` is not decoration: Won is measured awarded-first while open pipeline is a best-estimate,
 * so two numbers on the same screen can be counted differently. The web shows the basis; dropping it on
 * mobile would make the smaller screen the less honest one.
 */
export type ValueWithBasis = { amount: number; basisLabel: string };

export type ShowcasePeriod = { from: string; to: string; mode: WeekMode; label: string };

export type ExecHeroMetric = { count: number; value: ValueWithBasis };

/** Won / Sent / Estimated for the period — the three numbers the Monday meeting opens on. */
export type ExecHero = { won: ExecHeroMetric; sent: ExecHeroMetric; estimated: ExecHeroMetric };

export type DepartmentMetric = {
  key: string;
  label: string;
  /**
   * NULL is a real state, not a zero.
   *
   * A deferred department (Collected) has no number yet. The server is explicit that this is "a
   * placeholder, never a zero-filled real number", so rendering it as 0 would invent a fact.
   */
  count: number | null;
  value: ValueWithBasis | null;
  /** This week minus the last completed week. Null when the department is deferred. */
  deltaCountWoW: number | null;
  /** Eight Sunday-anchored weekly counts, oldest first. */
  sparkline: number[];
  deferred: boolean;
};

/**
 * The parts this screen renders. The payload also carries `reps`, `officeProjection` and `weeklyTrend`,
 * which are a table and a grid — deliberately not typed here, because typing them would invite a phone
 * to try rendering them.
 */
export type MondayShowcase = {
  period: ShowcasePeriod;
  departments: DepartmentMetric[];
  execHero: ExecHero;
  notes: string[];
};

/**
 * A budget that covers the report's own execution envelope.
 *
 * The client's default deadline is 30s (api/client.ts:49), and `getMondayShowcaseData` fans its
 * queries out SEQUENTIALLY with the pool allowing each one up to 30s (server/src/db.ts:23-39). On a
 * large office the whole report can legitimately outlast the client's patience — and aborting it does
 * not stop the server, so the automatic retry then starts a SECOND expensive report against a database
 * still computing the first.
 *
 * Two minutes is not a guess at how long it takes; it is long enough that a timeout here means
 * something is genuinely wrong rather than merely slow, which is the only useful thing a deadline can
 * tell you about a known-heavy endpoint.
 */
const SHOWCASE_TIMEOUT_MS = 120_000;

export async function getMondayShowcase(
  fetcher: Fetcher,
  mode: WeekMode,
): Promise<MondayShowcase> {
  // `{ data: ... }`, unwrapped here — routes.ts:1160 answers `res.json({ data })`, and this app's
  // envelope shapes vary per endpoint, so the wrapper is read off the route rather than assumed.
  const res = await fetcher<{ data: MondayShowcase }>(
    `/reports/monday-showcase?mode=${encodeURIComponent(mode)}`,
    { timeoutMs: SHOWCASE_TIMEOUT_MS },
  );
  return res.data;
}

/**
 * The records behind one showcase number.
 *
 * `won`, `sent` and `estimated` only. The endpoint also serves `pipeline`, `projection`, `leads` and
 * the blind-spot cohorts, but `assertShowcaseEvidenceAccess` restricts `pipeline` — along with an
 * explicit from/to window and `regionName` — to directors, and this app shows the report to reps. The
 * three metrics here are exactly the three figures the phone renders, which is the point: every number
 * on that screen can be opened, and nothing can be opened that the screen does not show.
 */
export type EvidenceMetric = "won" | "sent" | "estimated";

export type EvidenceRecord = {
  id: string;
  dealNumber: string | null;
  projectNumber: string | null;
  name: string;
  repName: string;
  stageLabel: string;
  /** This record's contribution to the number, in the metric's own basis. */
  value: number | null;
  /** The canonical date this record sits on FOR THIS METRIC — close date, sent date, and so on. */
  cohortDate: string | null;
  companyName: string | null;
};

export type ShowcaseEvidence = {
  metric: EvidenceMetric;
  metricLabel: string;
  /** Which date axis the records are on. Never a bare list — the server is explicit about this. */
  dateAxisLabel: string;
  period: ShowcasePeriod;
  total: { count: number; value: number | null; basisLabel: string | null };
  records: EvidenceRecord[];
};

export async function getShowcaseEvidence(
  fetcher: Fetcher,
  metric: EvidenceMetric,
  mode: WeekMode,
): Promise<ShowcaseEvidence> {
  const res = await fetcher<{ data: ShowcaseEvidence }>(
    `/reports/monday-showcase/evidence?metric=${encodeURIComponent(metric)}&mode=${encodeURIComponent(mode)}`,
    // Same reasoning as the report itself: this re-runs the cohort query and is not a 30s request.
    { timeoutMs: SHOWCASE_TIMEOUT_MS },
  );
  return res.data;
}
