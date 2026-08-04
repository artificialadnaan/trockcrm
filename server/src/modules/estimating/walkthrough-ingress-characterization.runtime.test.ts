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
//            INGRESS NOW BLOCKS THIS HAZARD AT ITS OWN DOOR: `ingestWalkthrough` refuses any row with
//            no spoken quantity, so a walkthrough can no longer be the thing that feeds the coercion.
//            The defect itself is UNREPAIRED — every other producer of `estimate_extractions` still
//            reaches those three call sites — so the characterization stays, now written as "the
//            coercion is still there, and we are refusing to hand it anything" rather than as "watch
//            our own null go through it".
// Defect 2 — natural-language scope prose scores zero name points against the catalog
//            (server/src/modules/estimating/matching-service.ts:69).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
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
import {
  getCrmFileBucket,
  ingestWalkthrough as ingestWalkthroughService,
} from "./walkthrough-ingress-service.js";

/**
 * R23/R25. Object storage, faked as HEALTHY and in agreement with the payload — the object is present and
 * its Content-Type/Content-Length are what was declared, so these characterization tests exercise the
 * defects they are about rather than the new verification. The dedicated R23 coverage lives in
 * walkthrough-ingress-service.runtime.test.ts.
 */
function ingestWalkthrough(args: { tenantDb: unknown; payload: WalkthroughIngressPayload }) {
  return ingestWalkthroughService({
    tenantDb: args.tenantDb as never,
    payload: args.payload,
    contactSheetStore: {
      isConfigured: () => true,
      head: async () => ({
        contentType: args.payload.contactSheetMimeType,
        contentLength: args.payload.contactSheetBytes,
      }),
      generateImageThumbnail: async (r2Key, mimeType) =>
        mimeType === "image/jpeg" ? `thumbnails/${r2Key}` : null,
      generatePdfThumbnail: async () => null,
    },
  });
}

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const DEAL = U("c1111");
const WALKTHROUGH = U("c2222");
const USER = U("c3333");
const CATALOG_ITEM = U("c4444");

/** The exact expression the worker prices with, kept as one string so the source lock below cannot
 *  drift from the prose describing it. Recorded at the time of writing at
 *  worker/src/jobs/estimate-generation.ts:424 (buildPricingRecommendation input), :470
 *  (persistPricingRecommendationBundle, transactional branch) and :500 (same, non-transactional
 *  branch) — counted rather than pinned by line number, so unrelated edits above those lines do not
 *  fail the suite. */
const WORKER_QUANTITY_COERCION = "Number(extraction.quantity ?? 1)";
// REPAIRED. Was 3 — see the test below, which was written to notice exactly this.
const WORKER_QUANTITY_COERCION_SITES = 0;
// What replaced it, pinned as the PREDICATES rather than as the write they lead to. Asserting only
// `status: "needs_quantity"` would still pass if the test deciding WHEN to reach it were deleted —
// the write is the consequence, and a lock on a consequence is not a lock on the behaviour.
const WORKER_QUANTITY_GUARDS = [
  // 1. The row is skipped for having no quantity, before any matching work.
  "extraction.quantity === null",
  // 2. The flag is written, which is what keeps the row visible instead of dropped.
  'status: "needs_quantity"',
  // 3. The claim re-checks BOTH facts in the WHERE, so a row that gained a quantity between the
  //    select and the write is not stamped and stranded by a concurrent run — and it pins the STATUS
  //    it observed, so a reviewer who approved or rejected the row in that window is not overwritten.
  // Names the COLUMN, not just the operator: a bare "is null" matches any nullable predicate that
  // happens to be in the file and would keep passing after the quantity re-check was removed.
  // Nonpositive and NaN as well as null — the guard and the claim have to agree about what unpriceable
  // means. Named WITH the column, because a bare "is null or" matches any nullable predicate that
  // happens to be in the file and would keep passing after the quantity re-check was removed.
  "estimateExtractions.quantity} is null or",
  "= 'NaN'::numeric",
  "= ${extraction.status}",
];

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

/** The case ingress accepts: a number was spoken and confirmed. Present as a control, so the
 *  assertions below are demonstrably about NULL handling and not about quantities in general. */
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
  contactSheetBucket: getCrmFileBucket(),
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
  it("is now refused at ingress, so the coercion is never handed one of our rows", async () => {
    // The hazard, stated once: downstream, `Number(extraction.quantity ?? 1)` turns "nobody said how
    // much" into "exactly one of it" and prices it. At a $3.25/LF baseline the unpriceable row does
    // not surface as unpriceable — it surfaces as a confident $3.25 line item on an estimate a human
    // will sign. That is why ingress refuses the row rather than exporting the null and hoping.
    await expect(ingestWalkthrough({ tenantDb, payload: PAYLOAD })).rejects.toMatchObject({
      statusCode: 400,
      // The refusal names the row AND says why, so the sender is not left reading "quantity must be a
      // finite number" and concluding it sent the wrong TYPE.
      message: expect.stringContaining(UNSPOKEN_QUANTITY_ROW.sourceScopeItemId),
    });
    await expect(ingestWalkthrough({ tenantDb, payload: PAYLOAD })).rejects.toMatchObject({
      message: expect.stringContaining("has no spoken quantity"),
    });

    // The WHOLE walkthrough is refused, not just the offending row — including the good spoken one
    // alongside it. Nothing at all was written.
    const rows = await tenantDb
      .select({ id: estimateExtractions.id })
      .from(estimateExtractions)
      .where(eq(estimateExtractions.dealId, DEAL));
    expect(rows).toHaveLength(0);
  });

  it("still writes a spoken quantity through unchanged", async () => {
    // The control. Same payload minus the unspoken row: this is not "ingress rejects walkthroughs",
    // it is "ingress rejects rows with nothing to price".
    const { extractionIds } = await ingestWalkthrough({
      tenantDb,
      payload: { ...PAYLOAD, rows: [SPOKEN_QUANTITY_ROW] },
    });

    expect(extractionIds).toHaveLength(1);

    const [row] = await tenantDb
      .select({ quantity: estimateExtractions.quantity })
      .from(estimateExtractions)
      .where(eq(estimateExtractions.id, extractionIds[0]));

    expect(Number(row.quantity)).toBe(50);
  });

  it("NO LONGER applies that coercion anywhere in the worker — the defect is repaired", () => {
    // A SOURCE LOCK, not a behavior test, and it did its job: it was written to notice this exact
    // repair, and it failed the moment the repair landed. Read its previous instruction literally —
    // "if the worker now skips, flags, or zeroes quantity-less rows instead of silently pricing them
    // at 1, refusing them at ingress may no longer be the right call. Decide deliberately."
    //
    // DECIDED, and recorded here so the next reader inherits the reasoning rather than the puzzle:
    // the worker now SKIPS such a row before matching and marks it `needs_quantity`, so a null
    // quantity is no longer priced as one unit by anybody. That removes the reason the ingress refuses
    // null quantities — and lifting that refusal is the intended next step, so that a walk whose
    // quantities were never spoken can still reach an estimator as rows plainly marked as needing a
    // number.
    //
    // It is deliberately NOT lifted in the same change as the repair. The refusal is the only thing
    // standing between an unpriceable row and the old behaviour; removing it first, or together,
    // would mean any window where both are half-applied prices guesses silently. The guard above
    // stays until this assertion has shipped.
    if (!existsSync(WORKER_ESTIMATE_GENERATION_PATH)) {
      throw new Error(
        `CHARACTERIZATION TEST CANNOT RUN: expected the worker's estimate-generation job at ` +
          `${WORKER_ESTIMATE_GENERATION_PATH}, and it is not there. This test reads the worker's ` +
          `SOURCE across packages on purpose (the coercion is JavaScript's \`??\`, not our code, so ` +
          `no runtime assertion can see it repaired). If the file moved, update ` +
          `WORKER_ESTIMATE_GENERATION_PATH — do not delete this test.`
      );
    }

    const source = readFileSync(WORKER_ESTIMATE_GENERATION_PATH, "utf8");
    // COMMENTS STRIPPED BEFORE COUNTING, because the fix's own comment quotes the removed expression
    // verbatim to say what it replaced — and a source lock that counts prose cannot tell an explanation
    // of a defect from the defect. Naive substring counting made the repair look incomplete.
    const code = source
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
      })
      .join("\n");
    const occurrences = code.split(WORKER_QUANTITY_COERCION).length - 1;

    expect(occurrences).toBe(WORKER_QUANTITY_COERCION_SITES);
    // ABSENCE IS NOT ENOUGH. Deleting the coercion without putting anything in its place would also
    // satisfy the count above while leaving `Number(null)` = 0 to price the row at zero — a different
    // wrong answer wearing the same clothes. Each guard has to be positively present.
    for (const guard of WORKER_QUANTITY_GUARDS) {
      expect(code).toContain(guard);
    }
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
