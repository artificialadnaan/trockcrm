// CHARACTERIZATION TESTS — these assert behavior we do NOT want.
//
// Read that again before "fixing" anything here. Every assertion below pins a KNOWN DEFECT downstream
// of walkthrough ingress. They pass today because the defect is present. They exist so that the day
// someone repairs the defect, THIS FILE GOES RED — turning a silent change in how work gets priced
// into a deliberate decision made by a human who has to come read these comments first.
//
// So: a failure here is not necessarily a regression. It is a signal that the characterized behavior
// moved. Do not "repair" the assertion to match the new behavior without doing the work each test's
// comment describes.
//
// Defect 1 — a null quantity is priced as one unit (worker/src/jobs/estimate-generation.ts).
// Defect 2 — natural-language scope prose scores zero name points against the catalog
//            (server/src/modules/estimating/matching-service.ts:69).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  estimateDocumentParseRuns,
  estimateExtractions,
  estimateSourceDocuments,
  files,
} from "@trock-crm/shared/schema";
import type { WalkthroughIngressPayload, WalkthroughScopeRow } from "@trock-crm/shared/types";
import { tenantSchemaSql } from "../../../tests/helpers/tenant-schema-from-drizzle.js";
import { rankExtractionMatches } from "./matching-service.js";
import { ingestWalkthrough } from "./walkthrough-ingress-service.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const DEAL = U("c1111");
const WALKTHROUGH = U("c2222");
const USER = U("c3333");
const CATALOG_ITEM = U("c4444");

/** The exact expression the worker prices with. Kept as one string so the source lock below and the
 *  arithmetic assertion cannot drift apart. */
const WORKER_QUANTITY_COERCION = "Number(extraction.quantity ?? 1)";

/** Line numbers, at the time of writing, of every site that applies the coercion:
 *  worker/src/jobs/estimate-generation.ts:424 (buildPricingRecommendation input),
 *  :470 (persistPricingRecommendationBundle, transactional branch),
 *  :500 (persistPricingRecommendationBundle, non-transactional branch). */
const WORKER_QUANTITY_COERCION_LINES = [424, 470, 500];

const WORKER_ESTIMATE_GENERATION_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../worker/src/jobs/estimate-generation.ts"
);

let pg: PGlite;
// Typed loosely for the same reason walkthrough-ingress-service.runtime.test.ts does: the service is
// typed against NodePgDatabase and the PGlite driver is wire-compatible, not structurally identical.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tenantDb: any;

/** A row whose quantity was never spoken — the COMMON case, per the walkthrough safety rule that a
 *  quantity exists only if a human said it out loud and confirmed it. */
const UNSPOKEN_QUANTITY_ROW: WalkthroughScopeRow = {
  sourceScopeItemId: "scope-unspoken",
  rawLabel: "Replace wall base throughout",
  trade: "flooring",
  divisionHint: "09",
  quantity: null,
  unit: "LF",
  confidence: 0.82,
  evidenceText: "we'll need to replace the wall base throughout",
  evidence: { clipId: "clip-1", timelineMs: 41_000, frameKey: "frames/clip-1/41000.jpg" },
  locationLabel: "Corridor",
};

/** The rare case: a number was spoken and confirmed. Present as a control, so the assertions below
 *  are demonstrably about NULL handling and not about quantities in general. */
const SPOKEN_QUANTITY_ROW: WalkthroughScopeRow = {
  sourceScopeItemId: "scope-spoken",
  rawLabel: "Replace 50 lf of base at the east wall",
  trade: "flooring",
  divisionHint: "09",
  quantity: 50,
  unit: "LF",
  confidence: 0.91,
  evidenceText: "replace fifty linear feet of base on the east wall",
  evidence: { clipId: "clip-1", timelineMs: 96_000, frameKey: "frames/clip-1/96000.jpg" },
  locationLabel: "Corridor",
};

const PAYLOAD: WalkthroughIngressPayload = {
  walkthroughId: WALKTHROUGH,
  dealId: DEAL,
  projectId: null,
  contactSheetR2Key: "walkthroughs/c2222/contact-sheet.jpg",
  contactSheetBucket: "trock-scope",
  contactSheetBytes: 92_160,
  contactSheetMimeType: "image/jpeg",
  siteLabel: "Corridor 2",
  capturedAt: "2026-07-29T16:20:00Z",
  userId: USER,
  rows: [UNSPOKEN_QUANTITY_ROW, SPOKEN_QUANTITY_ROW],
};

beforeAll(async () => {
  pg = new PGlite();
  // Only the four tables the ingress chain itself writes: this file never reads the workbench, so the
  // market/pricing/deal tables that suite needs are not on any read path here.
  await pg.exec(
    tenantSchemaSql("public", [
      files,
      estimateSourceDocuments,
      estimateDocumentParseRuns,
      estimateExtractions,
    ])
  );
  tenantDb = drizzle(pg);
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

describe("DEFECT 1 — a walkthrough row with no spoken quantity is priced as one unit", () => {
  it("writes null to the database and the worker's coercion turns that null into 1", async () => {
    const { extractionIds } = await ingestWalkthrough({ tenantDb, payload: PAYLOAD });
    expect(extractionIds).toHaveLength(2);

    const rows = await tenantDb
      .select({
        rawLabel: estimateExtractions.rawLabel,
        quantity: estimateExtractions.quantity,
      })
      .from(estimateExtractions)
      .where(eq(estimateExtractions.dealId, DEAL))
      .orderBy(asc(estimateExtractions.rawLabel));

    const unspoken = rows.find((row: { rawLabel: string }) => row.rawLabel === UNSPOKEN_QUANTITY_ROW.rawLabel);
    const spoken = rows.find((row: { rawLabel: string }) => row.rawLabel === SPOKEN_QUANTITY_ROW.rawLabel);

    // Our half of the contract holds: "no quantity was spoken" reaches storage as NULL, not as 0 and
    // not as 1. Everything below is what happens to that NULL after it leaves us.
    expect(unspoken?.quantity).toBeNull();
    expect(Number(spoken?.quantity)).toBe(50);

    // THE DEFECT. This is the worker's expression, applied verbatim to the row we just wrote. An
    // utterance that named no quantity is about to be priced as exactly one of whatever it matched.
    //
    // IF THIS ASSERTION EVER FAILS, THE WORKER WAS FIXED. Go revisit the "never export a null
    // quantity" rule in walkthrough-ingress-service.ts (`quantity: row.quantity === null ? null :
    // String(row.quantity)`): that rule is written on the assumption that null survives to a human,
    // and if the worker now skips, flags, or zeroes null-quantity rows instead of silently pricing
    // them at 1, exporting null may finally be safe — or may have become a different kind of wrong.
    // Decide deliberately. Do not just update the number.
    expect(Number(unspoken?.quantity ?? 1)).toBe(1);

    // What that costs, concretely: at a $3.25/LF baseline the unpriceable row does not surface as
    // unpriceable — it surfaces as a confident $3.25 line item on an estimate a human will sign.
    expect(Number(unspoken?.quantity ?? 1) * 3.25).toBe(3.25);
  });

  it("still applies that coercion at all three call sites in the worker", () => {
    // A source lock, not a behavior test. The arithmetic above would keep passing if the worker were
    // repaired, because `??` is JavaScript, not our code — so the only way to notice the repair is to
    // look at the worker itself. Counted rather than pinned by line number so that unrelated edits
    // above these lines do not fail the suite; the line numbers are recorded in
    // WORKER_QUANTITY_COERCION_LINES for whoever comes to find them.
    const source = readFileSync(WORKER_ESTIMATE_GENERATION_PATH, "utf8");
    const occurrences = source.split(WORKER_QUANTITY_COERCION).length - 1;

    expect(WORKER_QUANTITY_COERCION_LINES).toHaveLength(3);
    expect(occurrences).toBe(WORKER_QUANTITY_COERCION_LINES.length);

    // Recorded so the failure message names the sites rather than making the next reader grep:
    // :424 pricing input, :470 transactional persist, :500 non-transactional persist.
    const lines = source.split("\n");
    const stillPresentAtRecordedLines = WORKER_QUANTITY_COERCION_LINES.filter((lineNumber) =>
      lines[lineNumber - 1]?.includes(WORKER_QUANTITY_COERCION)
    );
    // Soft: if the file shifted, this drops below 3 while the count above still holds. That is a
    // stale-comment signal, not a defect signal — update WORKER_QUANTITY_COERCION_LINES.
    expect(stillPresentAtRecordedLines.length).toBeGreaterThan(0);
  });
});

describe("DEFECT 2 — natural-language walkthrough scope earns no name points against the catalog", () => {
  it("scores prose below the 50-point exact-name threshold with exactNameMatch false", async () => {
    // A real call into the real ranker, with every required field of RankExtractionMatchesArgs
    // populated (matching-service.ts:1-22).
    const ranked = await rankExtractionMatches({
      extraction: {
        // Exactly what walkthrough ingress writes: normalizedLabel is the spoken rawLabel lowercased
        // (walkthrough-ingress-service.ts), so it is a SENTENCE, never a catalog item name.
        normalizedLabel: "replace 50 lf of base",
        unit: "LF",
        divisionHint: "09",
      },
      catalogItems: [
        {
          id: CATALOG_ITEM,
          name: "Wall Base - Rubber 4in",
          unit: "LF",
          primaryCode: "09-650",
          catalogBaselinePrice: "3.25",
        },
      ],
      historicalItems: [],
    });

    const [topMatch] = ranked;

    // THE DEFECT. matching-service.ts:69 awards its 50 points only for
    // `item.name.toLowerCase() === normalizedLabel` — full string equality. A human describing the
    // very item this catalog row IS earns none of them, because "replace 50 lf of base" is not the
    // string "wall base - rubber 4in". Only unit (+15) and division (+15) survive.
    expect(topMatch.reasons.exactNameMatch).toBe(false);
    expect(topMatch.matchScore).toBeLessThan(50);
    expect(topMatch.matchScore).toBe(30);

    // IF THIS EVER FAILS, someone taught the ranker to read prose (fuzzy/token/embedding matching).
    // That is the fix we want — but it changes which catalog item every walkthrough row prices
    // against, so re-baseline pricing expectations rather than editing the number here.
  });

  it("proves the 50 points are reachable only by whole-string equality", async () => {
    // The control. Same catalog item, same units, same division — the ONLY change is that the
    // extraction label is now character-for-character the item name, lowercased. The score jumps by
    // exactly the 50 points the prose case could not earn, which is what makes the case above a
    // statement about matching-service.ts:69 rather than about this fixture.
    const ranked = await rankExtractionMatches({
      extraction: {
        normalizedLabel: "wall base - rubber 4in",
        unit: "LF",
        divisionHint: "09",
      },
      catalogItems: [
        {
          id: CATALOG_ITEM,
          name: "Wall Base - Rubber 4in",
          unit: "LF",
          primaryCode: "09-650",
          catalogBaselinePrice: "3.25",
        },
      ],
      historicalItems: [],
    });

    const [topMatch] = ranked;

    expect(topMatch.reasons.exactNameMatch).toBe(true);
    expect(topMatch.matchScore).toBe(80);
  });
});
