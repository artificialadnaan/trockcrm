import { describe, expect, it } from "vitest";
import {
  CURRENT_WEEKLY_REPORT_PDF_RENDER_VERSION,
  classifyWeeklyReportArtifact,
  isContentAddressedWeeklyReportPdfKey,
  isFutureRendererWeeklyReportPdfStale,
  needsWeeklyReportPdfRegeneration,
  weeklyReportPdfDigest,
  weeklyReportPdfKeyMarksSuperseded,
  weeklyReportPdfR2Key,
  type WeeklyReportPdfArtifactState,
} from "./pdf-artifact.js";

const DIGEST = "a".repeat(64);
const V = CURRENT_WEEKLY_REPORT_PDF_RENDER_VERSION;
const RENDERED_AT = new Date("2026-08-14T10:00:00.000Z");

function state(overrides: Partial<WeeklyReportPdfArtifactState> = {}): WeeklyReportPdfArtifactState {
  return {
    pdfR2Key: weeklyReportPdfR2Key("dallas", "DFW-10432", "deal-1", "report-1", V, DIGEST),
    pdfRenderVersion: V,
    pdfGeneratedAt: RENDERED_AT,
    updatedAt: RENDERED_AT,
    liveInputGeneration: new Date(RENDERED_AT.getTime() - 60_000),
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

  it("regenerates when nothing was ever rendered but a key exists", () => {
    expect(needsWeeklyReportPdfRegeneration(state({ pdfGeneratedAt: null }))).toBe(true);
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
