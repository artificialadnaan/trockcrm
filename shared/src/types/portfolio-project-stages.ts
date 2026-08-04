/**
 * Procore Portfolio project stages.
 * =================================
 *
 * Three DISJOINT classes of stage, and the distinction is load-bearing:
 *
 *   1. BOARD stages (`PORTFOLIO_PROJECT_BOARD_STAGES`) — get a column on the Projects
 *      board, in construction-lifecycle order, with the Service track kept separate at
 *      the end so service work is never silently merged into construction numbers.
 *   2. OFF-BOARD stages (`PORTFOLIO_PROJECT_OFF_BOARD_STAGES`) — recognised, mapped, and
 *      DELIBERATELY excluded from the board (the two dead Procore legacy buckets). These
 *      are not ingested and never reach the board.
 *   3. Everything else — a stage nobody anticipated. It is NOT excluded: it stays
 *      board-relevant (so it is still ingested) and the board groups it into an
 *      "Other / No Column" column. See `isPortfolioProjectBoardRelevantStage`.
 *
 * The reason class 3 exists at all: before this, an unrecognised stage fell through the
 * alias map and the project was dropped from the board AND from the board's project list
 * entirely — invisible, uncounted, indistinguishable from "not in Procore". Deliberate
 * exclusion must be something the code can SAY (class 2), so that silence (class 3) can
 * safely mean "surface it anyway" instead of "delete it".
 */

export const PORTFOLIO_PROJECT_BOARD_STAGES = [
  // Construction track, in lifecycle order.
  "bidding",
  "estimating",
  "pre-construction",
  "buyout",
  "contract executed",
  "in production",
  "close out",
  "close out - final invoice",
  "closed",
  // Service track. Deliberately its own run of columns rather than folded into the
  // construction stages above: service revenue is reported separately.
  "service - estimating",
  "service - in production",
  "service - close out",
  "service - close out final invoice",
  "service - lost",
] as const;

export type PortfolioProjectBoardStage = typeof PORTFOLIO_PROJECT_BOARD_STAGES[number];

/**
 * Stages that are mapped on purpose and kept OFF the board. Procore's two legacy buckets
 * are genuinely dead work (~183 of the 378 active projects at time of writing). They are
 * listed explicitly so they are excluded BY DECISION, not by accidentally having no alias.
 */
export const PORTFOLIO_PROJECT_OFF_BOARD_STAGES = [
  "hold (legacy)",
  "lost/cancelled (legacy)",
] as const;

export type PortfolioProjectOffBoardStage = typeof PORTFOLIO_PROJECT_OFF_BOARD_STAGES[number];

/**
 * Synthetic column key for projects whose stage matches no board column. Not a Procore
 * stage — it only ever exists in the board grouping, never in the database.
 */
export const PORTFOLIO_UNMAPPED_BOARD_STAGE = "unmapped";

/** Stages whose contract value rolls up into "production revenue", split by track. */
export const PORTFOLIO_PRODUCTION_ROLLUP_CONSTRUCTION_STAGES = [
  "buyout",
  "pre-construction",
  "in production",
] as const satisfies readonly PortfolioProjectBoardStage[];

export const PORTFOLIO_PRODUCTION_ROLLUP_SERVICE_STAGES = [
  "service - in production",
] as const satisfies readonly PortfolioProjectBoardStage[];

/** A project's value is "stale" once its last sync from Procore is older than this. */
export const PORTFOLIO_VALUE_STALE_AFTER_DAYS = 7;

const STAGE_ALIASES: Record<string, PortfolioProjectBoardStage | PortfolioProjectOffBoardStage> = {
  "bid": "bidding",
  "bidding": "bidding",
  "estimating": "estimating",
  "estimate": "estimating",
  "estimation": "estimating",
  // Procore writes "Pre-Construction"; the normalizer expands the hyphen to " - ", so the
  // canonical spelling is reachable via the normalized, hyphen-as-space, and compact forms.
  "pre-construction": "pre-construction",
  "pre - construction": "pre-construction",
  "pre construction": "pre-construction",
  "preconstruction": "pre-construction",
  "buy out": "buyout",
  "buy-out": "buyout",
  "buyout": "buyout",
  "closeout": "close out",
  "close out": "close out",
  "close-out": "close out",
  "close out final invoice": "close out - final invoice",
  "close out - final invoice": "close out - final invoice",
  "close-out final invoice": "close out - final invoice",
  "closeout final invoice": "close out - final invoice",
  "closed": "closed",
  "contract executed": "contract executed",
  "contracts executed": "contract executed",
  "in production": "in production",
  "production": "in production",

  // Service track. Note the asymmetry in Procore's own data: the service final-invoice
  // stage has NO hyphen before "Final" ("Service - Close Out Final Invoice") while the
  // construction one does ("Close Out - Final Invoice"). Both spellings are mapped, and
  // the hyphen-as-space lookup absorbs either punctuation.
  "service - estimating": "service - estimating",
  "service estimating": "service - estimating",
  "service - in production": "service - in production",
  "service in production": "service - in production",
  "service - close out": "service - close out",
  "service close out": "service - close out",
  "service - closeout": "service - close out",
  "service - close out final invoice": "service - close out final invoice",
  "service close out final invoice": "service - close out final invoice",
  "service - closeout final invoice": "service - close out final invoice",
  "service - lost": "service - lost",
  "service lost": "service - lost",

  // Deliberately OFF the board (see PORTFOLIO_PROJECT_OFF_BOARD_STAGES).
  "hold (legacy)": "hold (legacy)",
  "hold": "hold (legacy)",
  "lost/cancelled (legacy)": "lost/cancelled (legacy)",
  "lost / cancelled (legacy)": "lost/cancelled (legacy)",
  "lost/cancelled": "lost/cancelled (legacy)",
};

/**
 * EVERY spelling that classifies as off-board — the alias keys, not just the two canonical
 * values. Derived from the map rather than hand-listed, so it cannot fall behind it.
 *
 * Exists because SQL cannot call this module. Migration 0216 has to decide the same question
 * ("does this raw stage belong to a dead legacy bucket?") against raw `current_stage` text, and
 * excluding only the two CANONICAL strings missed `Hold`, `Lost/Cancelled` and
 * `Lost / Cancelled (Legacy)` — flipping genuinely dead work onto the board. A drift test pins
 * the migration's list against this constant.
 */
export const PORTFOLIO_OFF_BOARD_STAGE_ALIASES: readonly string[] = Object.entries(STAGE_ALIASES)
  .filter(([, canonical]) => (PORTFOLIO_PROJECT_OFF_BOARD_STAGES as readonly string[]).includes(canonical))
  .map(([alias]) => alias)
  .sort();

/**
 * Purely TEXTUAL normalization — case, underscores, whitespace, hyphen spacing — with NO alias
 * table consulted. Exported because it is the one form that is stable across alias-map edits.
 *
 * Anything PERSISTED that is derived from a stage should be derivable from this, not from the
 * alias output: `normalizePortfolioProjectStage` returns this value only for stages that have
 * no alias, so adding an alias silently changes the alias output for that stage. Stage-event
 * idempotency keys are the place that bit us — see `legacyEventKeysForPayload` in
 * procore-project-stage-relay-service.ts.
 */
export function bareNormalizePortfolioProjectStage(stage: string | null | undefined): string {
  return String(stage ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, " ")
    .replace(/\s*-\s*/g, " - ")
    .replace(/\s+/g, " ");
}

export function normalizePortfolioProjectStage(stage: string | null | undefined): string {
  const normalized = bareNormalizePortfolioProjectStage(stage);

  const hyphenAsSpace = normalized.replace(/\s*-\s*/g, " ").replace(/\s+/g, " ");
  const compactHyphen = normalized.replace(/\s*-\s*/g, "-");

  return STAGE_ALIASES[normalized]
    ?? STAGE_ALIASES[hyphenAsSpace]
    ?? STAGE_ALIASES[compactHyphen]
    ?? normalized;
}

/** True when the stage maps to one of the board's own columns. */
export function isPortfolioProjectBoardStage(stage: string | null | undefined): stage is PortfolioProjectBoardStage {
  return PORTFOLIO_PROJECT_BOARD_STAGES.includes(
    normalizePortfolioProjectStage(stage) as PortfolioProjectBoardStage
  );
}

/** True only for the stages we have decided, explicitly, to keep off the board. */
export function isPortfolioProjectOffBoardStage(stage: string | null | undefined): boolean {
  return PORTFOLIO_PROJECT_OFF_BOARD_STAGES.includes(
    normalizePortfolioProjectStage(stage) as PortfolioProjectOffBoardStage
  );
}

/**
 * Drives the `is_board_relevant` column written by the seed and the webhook relay.
 *
 * Fails OPEN on purpose: an unrecognised stage stays relevant so it is still ingested and
 * still shows up (in the board's "Other / No Column" column) instead of disappearing. Only
 * the explicitly-listed off-board stages are filtered out. An empty/absent stage is not a
 * decision either, so it too stays relevant rather than being silently discarded.
 */
export function isPortfolioProjectBoardRelevantStage(stage: string | null | undefined): boolean {
  return !isPortfolioProjectOffBoardStage(stage);
}
