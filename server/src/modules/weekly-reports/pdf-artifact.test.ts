import { describe, expect, it } from "vitest";
import {
  CURRENT_WEEKLY_REPORT_PDF_RENDER_VERSION,
  classifyWeeklyReportArtifact,
  isContentAddressedWeeklyReportPdfKey,
  isFutureRendererWeeklyReportPdfStale,
  needsWeeklyReportPdfRegeneration,
  newestWeeklyReportGeneration,
  weeklyReportContentGeneration,
  weeklyReportGeneration,
  weeklyReportGenerationSql,
  weeklyReportPdfDigest,
  weeklyReportPdfKeyMarksSuperseded,
  weeklyReportPdfR2Key,
  type WeeklyReportPdfArtifactState,
} from "./pdf-artifact.js";

const DIGEST = "a".repeat(64);
const V = CURRENT_WEEKLY_REPORT_PDF_RENDER_VERSION;
/** The content generation the stored bytes were rendered FROM — not a clock reading of when. */
const RENDERED_AT = new Date("2026-08-14T10:00:00.000Z");
// Two generations 500 MICROSECONDS apart, spelled the way the loader reads them off Postgres. Both collapse
// to the same JS Date, which is precisely why they are written out rather than derived from one.
const MICRO_RENDERED = "2026-08-14T10:00:00.123400Z";
const MICRO_EDITED = "2026-08-14T10:00:00.123900Z";

function state(overrides: Partial<WeeklyReportPdfArtifactState> = {}): WeeklyReportPdfArtifactState {
  return {
    pdfR2Key: weeklyReportPdfR2Key("dallas", "DFW-10432", "deal-1", "report-1", V, DIGEST),
    pdfRenderVersion: V,
    pdfContentGeneration: RENDERED_AT,
    updatedAt: RENDERED_AT,
    liveInputGeneration: new Date(RENDERED_AT.getTime() - 60_000),
    // Null is the ordinary case: the property is named, so `deals.name` is not a render input at all.
    dealNameGeneration: null,
    // The default is a SENT report.
    contentFrozen: true,
    superseded: false,
    ...overrides,
  };
}

describe("weeklyReportPdfR2Key", () => {
  it("keys on the deal number, the report, the render version and the bytes", () => {
    expect(weeklyReportPdfR2Key("dallas", "DFW-10432", "deal-1", "report-1", 1, DIGEST)).toBe(
      `office_dallas/deals/DFW-10432/documents/weekly-reports/report-1.${DIGEST}.v1.pdf`,
    );
  });

  it("falls back to the deal id when the deal has no number", () => {
    expect(weeklyReportPdfR2Key("dallas", "   ", "deal-1", "report-1", 1, DIGEST)).toContain("/deals/deal-1/");
  });

  it("refuses a digest that is not a SHA-256 hex value", () => {
    // A key built from something else would never match isContentAddressedWeeklyReportPdfKey, so every
    // subsequent read would classify it as legacy and re-render — forever, silently.
    expect(() => weeklyReportPdfR2Key("dallas", null, "deal-1", "report-1", 1, "not-a-digest")).toThrow(/SHA-256/);
  });

  it("produces a DIFFERENT key for different bytes, so concurrent renders cannot collide", () => {
    const a = weeklyReportPdfDigest(Buffer.from("one"));
    const b = weeklyReportPdfDigest(Buffer.from("two"));
    expect(a).not.toBe(b);
    expect(weeklyReportPdfR2Key("dallas", "D-1", "deal", "report", V, a)).not.toBe(
      weeklyReportPdfR2Key("dallas", "D-1", "deal", "report", V, b),
    );
  });
});

describe("isContentAddressedWeeklyReportPdfKey", () => {
  it("accepts only the current publisher's shape at the given version", () => {
    const key = weeklyReportPdfR2Key("dallas", "D-1", "deal", "report", 2, DIGEST);
    expect(isContentAddressedWeeklyReportPdfKey(key, 2)).toBe(true);
    expect(isContentAddressedWeeklyReportPdfKey(key, 1)).toBe(false);
  });

  it("rejects a legacy, non-content-addressed key", () => {
    expect(isContentAddressedWeeklyReportPdfKey("office_dallas/deals/D-1/report.pdf", 1)).toBe(false);
  });
});

describe("needsWeeklyReportPdfRegeneration", () => {
  it("is false for a current artifact", () => {
    expect(needsWeeklyReportPdfRegeneration(state())).toBe(false);
    expect(classifyWeeklyReportArtifact(state())).toBe("current");
  });

  it("regenerates when there is no artifact at all", () => {
    expect(needsWeeklyReportPdfRegeneration(state({ pdfR2Key: null }))).toBe(true);
    expect(needsWeeklyReportPdfRegeneration(state({ pdfR2Key: "   " }))).toBe(true);
  });

  it("regenerates an artifact from an older renderer", () => {
    expect(needsWeeklyReportPdfRegeneration(state({ pdfRenderVersion: V - 1 }))).toBe(true);
  });

  it("regenerates when the report has been edited since the render", () => {
    // The whole point of the generation comparison: a content-addressed key stays valid-LOOKING forever, so
    // without this an edited report keeps serving the PDF of what it used to say.
    const edited = state({ updatedAt: new Date(RENDERED_AT.getTime() + 5_000) });
    expect(needsWeeklyReportPdfRegeneration(edited)).toBe(true);
    expect(classifyWeeklyReportArtifact(edited)).toBe("stale");
  });

  it("does not re-render forever when the publish landed in the same millisecond as the edit", () => {
    // A strict `<` would call a freshly-published artifact stale on the very next read, and every download
    // would then pay for a full render.
    expect(needsWeeklyReportPdfRegeneration(state({ updatedAt: RENDERED_AT }))).toBe(false);
  });

  it("regenerates for an edit one millisecond after the render", () => {
    expect(
      needsWeeklyReportPdfRegeneration(state({ updatedAt: new Date(RENDERED_AT.getTime() + 1) })),
    ).toBe(true);
  });

  it("regenerates for an edit LESS than a millisecond after the render", () => {
    // `timestamptz` is MICROseconds; node-postgres materialises it as a millisecond JS Date. A comparison
    // that goes through Date therefore calls these two generations equal, `current <= rendered` holds, and
    // the artifact classifies current — the web page shows the edit and the cached PDF does not. A render
    // reads its inputs and publishes microseconds later, so this window is where a concurrent edit lands,
    // and for a SENT report nothing ever moves updated_at again to break the tie.
    const edited = state({ pdfContentGeneration: MICRO_RENDERED, updatedAt: MICRO_EDITED });
    expect(needsWeeklyReportPdfRegeneration(edited)).toBe(true);
    expect(classifyWeeklyReportArtifact(edited)).toBe("stale");
  });

  it("regenerates for a LIVE input that moved less than a millisecond after the render", () => {
    // Same defect through the other door: a photo soft-deleted or a superintendent swapped in the same
    // millisecond the render read the row. weekly_reports.updated_at does not move for either.
    const edited = state({
      contentFrozen: false,
      pdfContentGeneration: MICRO_RENDERED,
      updatedAt: MICRO_RENDERED,
      liveInputGeneration: MICRO_EDITED,
    });
    expect(needsWeeklyReportPdfRegeneration(edited)).toBe(true);
    expect(classifyWeeklyReportArtifact(edited)).toBe("stale");
  });

  it("regenerates for a deal rename less than a millisecond after the render, even once SENT", () => {
    // The one live input a frozen report still reads, so a sub-millisecond collision here is permanent.
    const renamed = state({
      contentFrozen: true,
      pdfContentGeneration: MICRO_RENDERED,
      updatedAt: MICRO_RENDERED,
      dealNameGeneration: MICRO_EDITED,
    });
    expect(needsWeeklyReportPdfRegeneration(renamed)).toBe(true);
    expect(classifyWeeklyReportArtifact(renamed)).toBe("stale");
  });

  it("still caches an artifact whose generation matches to the microsecond", () => {
    // The other half of the same comparison: precision must not turn `<=` into a permanent re-render. The
    // publisher writes the generation it read, so a quiet report compares exactly equal, microseconds and
    // all, on every later download.
    const quiet = state({ pdfContentGeneration: MICRO_RENDERED, updatedAt: MICRO_RENDERED });
    expect(needsWeeklyReportPdfRegeneration(quiet)).toBe(false);
    expect(classifyWeeklyReportArtifact(quiet)).toBe("current");
  });

  it("regenerates when a key exists but records no generation", () => {
    // Never rendered, or rendered by an instance that predates the pdf_content_generation column (0224).
    // Either way nothing vouches for those bytes, so they are re-made once rather than trusted.
    expect(needsWeeklyReportPdfRegeneration(state({ pdfContentGeneration: null }))).toBe(true);
  });

  it("repairs a key/version mismatch left by a mid-deploy write", () => {
    expect(
      needsWeeklyReportPdfRegeneration(state({ pdfR2Key: "office_dallas/deals/D-1/legacy.pdf" })),
    ).toBe(true);
  });

  it("treats an unreadable report as current rather than looping on it", () => {
    expect(needsWeeklyReportPdfRegeneration(state({ updatedAt: null }))).toBe(false);
  });

  it("will not downgrade a newer renderer's artifact", () => {
    expect(needsWeeklyReportPdfRegeneration(state({ pdfRenderVersion: V + 1 }))).toBe(false);
  });

  it("CACHES the artifact of an approved report whose header has not moved", () => {
    // The defect this closes: `contentFrozen` is `status === "sent"`, and an earlier revision treated any
    // unfrozen report as stale unconditionally. An approved report is exactly what a client's link points
    // at, so every anonymous download re-rendered and re-uploaded — landing on a NEW content-addressed key
    // each time, because the render is not byte-reproducible, with nothing that ever deletes the last one.
    expect(needsWeeklyReportPdfRegeneration(state({ contentFrozen: false }))).toBe(false);
    expect(classifyWeeklyReportArtifact(state({ contentFrozen: false }))).toBe("current");
  });

  it("regenerates an approved report's artifact when a LIVE input moved", () => {
    // The reason the unfrozen case was blanket-stale in the first place. Before send the render also reads
    // weekly_report_projects, public.users and the selected files, none of which touches
    // weekly_reports.updated_at — so renaming the property, swapping the superintendent or soft-deleting a
    // photo has to be caught here, or the cached PDF says one thing while the live web page says another.
    const edited = state({
      contentFrozen: false,
      liveInputGeneration: new Date(RENDERED_AT.getTime() + 1),
    });
    expect(needsWeeklyReportPdfRegeneration(edited)).toBe(true);
    expect(classifyWeeklyReportArtifact(edited)).toBe("stale");
  });

  it("ignores a live-header edit once the report is SENT", () => {
    // A sent report renders from its own snapshot. A PM swapped in September must not invalidate — or
    // silently rewrite — the PDF a client was emailed in August.
    expect(
      needsWeeklyReportPdfRegeneration(
        state({ contentFrozen: true, liveInputGeneration: new Date(RENDERED_AT.getTime() + 5_000) }),
      ),
    ).toBe(false);
  });

  it("regenerates when the DEAL was renamed and the header prints the deal's name", () => {
    // The input that was outside every generation: `property_display_name` is nullable and clearable, and
    // both renderers then fall back to `deals.name` — which `deals.updated_at` tracks and nothing else
    // does. On an approved report, where a shared link sits indefinitely, a rename changed the live web
    // page while the cached PDF behind the same link kept the old name for good.
    const renamed = { dealNameGeneration: new Date(RENDERED_AT.getTime() + 1) };
    expect(needsWeeklyReportPdfRegeneration(state({ contentFrozen: false, ...renamed }))).toBe(true);

    // AND once the report is sent, unlike every other live input: the snapshot has no property name to
    // freeze in that case, so this fallback is the one thing a frozen report still reads live. Leaving it
    // out would let the page and the delivered PDF disagree permanently.
    expect(needsWeeklyReportPdfRegeneration(state({ contentFrozen: true, ...renamed }))).toBe(true);
  });

  it("but a deal edit does NOT invalidate a report whose header names the property", () => {
    // The other half, and the reason this is a separate field from liveInputGeneration: `deals.updated_at`
    // moves on any edit to the job, and a report that never reads the deal's name must not re-render — and
    // orphan another content-addressed object — every time somebody touches the deal.
    expect(
      needsWeeklyReportPdfRegeneration(
        state({ contentFrozen: false, dealNameGeneration: null, liveInputGeneration: RENDERED_AT }),
      ),
    ).toBe(false);
  });
});

describe("the generation representation", () => {
  it("substitutes the expression it is given, so a caller cannot silently read the wrong column", () => {
    // What this SQL actually EMITS is asserted by executing it — see the "a generation keeps every digit
    // Postgres stored" case in weekly-report-share.runtime.test.ts. Matching the text here would only
    // restate the implementation.
    expect(weeklyReportGenerationSql("wr.updated_at")).toContain("wr.updated_at");
    expect(weeklyReportGenerationSql("proj.updated_at")).not.toContain("wr.updated_at");
  });

  it("keeps a canonical generation verbatim, so the three uses cannot spell it differently", () => {
    // The coalescer key, the value the publisher binds and the value the comparison reads back are this
    // same string. Rewriting it here — even to an equivalent instant — would let them disagree.
    expect(weeklyReportGeneration(MICRO_EDITED)).toBe(MICRO_EDITED);
  });

  it("WIDENS a Date with zero microseconds rather than inventing any", () => {
    // A JS Date never had microseconds, so .123 is honestly .123000. What must never happen is a Date on
    // one side of a comparison and microsecond text on the other: the text keeps .123456 while the Date
    // claims .123000, and the artifact then reads stale on every single download. Hence the loader reads
    // every generation through weeklyReportGenerationSql.
    expect(weeklyReportGeneration(new Date("2026-08-14T10:00:00.123Z"))).toBe("2026-08-14T10:00:00.123000Z");
    expect(weeklyReportGeneration(null)).toBeNull();
    expect(weeklyReportGeneration("not a timestamp")).toBeNull();
  });

  it("takes the newest of several generations at microsecond resolution", () => {
    expect(newestWeeklyReportGeneration([MICRO_RENDERED, null, MICRO_EDITED, "rubbish"])).toBe(MICRO_EDITED);
    expect(newestWeeklyReportGeneration([null, undefined])).toBeNull();
  });

  it("returns the widened generation as the canonical text the publisher writes", () => {
    // weeklyReportContentGeneration is the ONE definition, so what it returns is literally what goes into
    // the coalescer key and into pdf_content_generation. A Date here would round-trip through the database
    // as .000 microseconds and no longer match the row it was read from.
    expect(
      weeklyReportContentGeneration(
        state({ contentFrozen: false, updatedAt: MICRO_RENDERED, liveInputGeneration: MICRO_EDITED }),
      ),
    ).toBe(MICRO_EDITED);
    // An unreadable row still yields no generation at all — the caller's 404 handling owns that case.
    expect(weeklyReportContentGeneration(state({ updatedAt: null }))).toBeNull();
  });
});

describe("CURRENT_WEEKLY_REPORT_PDF_RENDER_VERSION", () => {
  it("is 4 — and this assertion is the tripwire, not a tautology", () => {
    // Every other test in this file binds the constant, so none of them can notice it disagreeing with the
    // renderer. The version is a PROMISE about the bytes: it is in the object key and in the publication
    // CAS, so a layout change that forgets to bump it leaves every artifact rendered before the deploy
    // being served forever, and nothing fails — until a client asks why their PDF and their page differ.
    // Changing the renderer therefore means changing this line, deliberately, in the same commit.
    expect(CURRENT_WEEKLY_REPORT_PDF_RENDER_VERSION).toBe(4);
  });
});

describe("a superseded report", () => {
  // Being superseded moves no timestamp on this row — the correction is a different row entirely — so the
  // generation comparison cannot see it. Without the key marker a report superseded after publication would
  // keep serving the unmarked PDF, and a client forwarding it could not tell it had been replaced.
  it("regenerates once when the stored artifact predates the correction", () => {
    const s = state({ superseded: true });
    expect(needsWeeklyReportPdfRegeneration(s)).toBe(true);
    expect(classifyWeeklyReportArtifact(s)).toBe("stale");
  });

  it("is current again once the stored key records it", () => {
    const s = state({
      superseded: true,
      pdfR2Key: weeklyReportPdfR2Key("dallas", "DFW-10432", "deal-1", "report-1", V, DIGEST, true),
    });
    expect(needsWeeklyReportPdfRegeneration(s)).toBe(false);
    expect(classifyWeeklyReportArtifact(s)).toBe("current");
  });

  it("does not serve a superseded rendering for a report that is not superseded", () => {
    const s = state({
      superseded: false,
      pdfR2Key: weeklyReportPdfR2Key("dallas", "DFW-10432", "deal-1", "report-1", V, DIGEST, true),
    });
    expect(needsWeeklyReportPdfRegeneration(s)).toBe(true);
  });

  it("keys the two renderings apart, so neither can overwrite the other", () => {
    const plain = weeklyReportPdfR2Key("dallas", "D-1", "deal", "report", V, DIGEST);
    const marked = weeklyReportPdfR2Key("dallas", "D-1", "deal", "report", V, DIGEST, true);
    expect(marked).not.toBe(plain);
    expect(weeklyReportPdfKeyMarksSuperseded(marked)).toBe(true);
    expect(weeklyReportPdfKeyMarksSuperseded(plain)).toBe(false);
    // Both are still the current publisher's shape, or the marked one would re-render forever.
    expect(isContentAddressedWeeklyReportPdfKey(marked, V)).toBe(true);
  });
});

describe("the rolling-deploy case", () => {
  it("reports a newer-renderer artifact whose content has moved on as retryable, not current", () => {
    // needsWeeklyReportPdfRegeneration answers "can THIS instance supersede it?", which is deliberately
    // false here. Asking only that question would serve known-stale bytes indefinitely on an old instance.
    const s = state({ pdfRenderVersion: V + 1, updatedAt: new Date(RENDERED_AT.getTime() + 5_000) });
    expect(isFutureRendererWeeklyReportPdfStale(s)).toBe(true);
    expect(needsWeeklyReportPdfRegeneration(s)).toBe(false);
    expect(classifyWeeklyReportArtifact(s)).toBe("awaiting-newer-renderer");
  });

  it("serves a newer-renderer artifact whose content still matches", () => {
    const s = state({ pdfRenderVersion: V + 1 });
    expect(isFutureRendererWeeklyReportPdfStale(s)).toBe(false);
    expect(classifyWeeklyReportArtifact(s)).toBe("current");
  });

  it("treats a newer-renderer artifact whose LIVE header moved as retryable, never as current", () => {
    // This instance cannot re-render it (the CAS would match nothing) and cannot vouch for it either. The
    // header rows are what makes the difference for an unsent report — updated_at alone would look fine.
    const s = state({
      pdfRenderVersion: V + 1,
      contentFrozen: false,
      liveInputGeneration: new Date(RENDERED_AT.getTime() + 5_000),
    });
    expect(classifyWeeklyReportArtifact(s)).toBe("awaiting-newer-renderer");
  });
});
