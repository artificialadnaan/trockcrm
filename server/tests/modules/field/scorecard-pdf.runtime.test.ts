import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  buildScorecardPdfData,
  capEvidenceGroups,
  renderFieldScorecardPdf,
  signatureDataUrlToBuffer,
  typedSignatureFallback,
  type EvidenceGroup,
  type ScorecardPdfCorrectiveAction,
  MAX_CORRECTIVE_ACTION_PHOTOS,
  type ScorecardPdfPhoto,
} from "../../../src/modules/field/scorecard-pdf.js";
import {
  isRenderableSignatureDataUrl,
  typedSignatureFallback as sharedTypedSignatureFallback,
} from "@trock-crm/shared/types";

// Compact data URL used to exercise the handwritten-signature parsing helpers below. Evidence rendering
// uses the tracked 32x32 PNG because PDFKit rejects this minimal 1x1 fixture while decoding an image tile.
const TINY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const TINY_PNG = Buffer.from(TINY_PNG_DATA_URL.split(",")[1], "base64");
const EVIDENCE_PNG = readFileSync(new URL("../../../../client-field/public/favicon-32x32.png", import.meta.url));
const EVIDENCE_PNG_DATA_URL = `data:image/png;base64,${EVIDENCE_PNG.toString("base64")}`;

function embeddedImageObjectCount(pdf: Buffer): number {
  return pdf.toString("latin1").match(/\/Subtype\s*\/Image\b/g)?.length ?? 0;
}

function photo(over: Partial<ScorecardPdfPhoto> = {}): ScorecardPdfPhoto {
  return { sectionKey: "quality", deficiencyKey: null, caption: "Framing detail", image: null, ...over };
}

function group(title: string, count: number): EvidenceGroup {
  return { title, subtitle: null, photos: Array.from({ length: count }, () => photo()) };
}

describe("field scorecard PDF evidence", () => {
  it("embeds non-null evidence bytes as PDF image objects instead of rendering only a placeholder", async () => {
    const input = {
      dealName: "Maple Street Tower",
      projectNumber: "DFW-10432",
      weekOf: "2026-07-06",
      superintendentName: "Sam Super",
      pmName: "Pat Manager",
      submittedByName: "Sam Super",
      submittedAt: "2026-07-10T17:00:00.000Z",
      totalScore: 84,
      formVersion: 2 as const,
      averageScore: 8.4,
      rating: "on_standard" as const,
      items: [{ sectionKey: "quality", points: 8, note: "Reinspect framing." }],
      criticalDeficiencyKeys: [] as string[],
      actionItems: [] as string[],
    };

    // Both documents have the same branded summary/evidence pages (and therefore the same logo image
    // objects). The only difference is whether the evidence tile receives decodable image bytes.
    const placeholderPdf = await renderFieldScorecardPdf(buildScorecardPdfData({
      ...input,
      photos: [{ sectionKey: "quality", deficiencyKey: null, caption: "Framing detail", image: null }],
    }));
    const evidencePdf = await renderFieldScorecardPdf(buildScorecardPdfData({
      ...input,
      photos: [{ sectionKey: "quality", deficiencyKey: null, caption: "Framing detail", image: EVIDENCE_PNG }],
    }));

    expect(embeddedImageObjectCount(evidencePdf)).toBeGreaterThan(embeddedImageObjectCount(placeholderPdf));
  });

  it("embeds a decodable handwritten data-URL signature while typed legacy signatures stay text", async () => {
    const input = {
      dealName: "Maple Street Tower",
      projectNumber: "DFW-10432",
      weekOf: "2026-07-06",
      superintendentName: "Sam Super",
      pmName: "Pat Manager",
      submittedByName: "Sam Super",
      submittedAt: "2026-07-10T17:00:00.000Z",
      totalScore: 84,
      formVersion: 2 as const,
      averageScore: 8.4,
      rating: "on_standard" as const,
      items: [{ sectionKey: "quality", points: 8, note: "Reinspect framing." }],
      criticalDeficiencyKeys: [] as string[],
      actionItems: [] as string[],
      photos: [] as ScorecardPdfPhoto[],
      pmSignature: "Pat Q. Manager",
    };
    const typedOnly = await renderFieldScorecardPdf(buildScorecardPdfData({
      ...input,
      superintendentSignature: "Sam Superintendent",
    }));
    const handwritten = await renderFieldScorecardPdf(buildScorecardPdfData({
      ...input,
      superintendentSignature: EVIDENCE_PNG_DATA_URL,
    }));

    expect(embeddedImageObjectCount(handwritten)).toBeGreaterThan(embeddedImageObjectCount(typedOnly));
  });

  it("groups section and deficiency photos with their descriptions and renders a PDF", async () => {
    const data = buildScorecardPdfData({
      dealName: "Maple Street Tower",
      projectNumber: "DFW-10432",
      weekOf: "2026-07-06",
      superintendentName: "Sam Super",
      pmName: "Pat Manager",
      submittedByName: "Sam Super",
      submittedAt: "2026-07-10T17:00:00.000Z",
      totalScore: 84,
      formVersion: 2,
      averageScore: 8.4,
      rating: "on_standard",
      items: [{ sectionKey: "quality", points: 8, note: "Reinspect framing." }],
      criticalDeficiencyKeys: ["failed_inspection"],
      criticalDeficiencyNotes: { failed_inspection: "Correct before drywall." },
      actionItems: ["Schedule reinspection"],
      photos: [
        { sectionKey: "quality", deficiencyKey: null, caption: "Framing detail", image: null },
        { sectionKey: "critical_deficiency", deficiencyKey: "failed_inspection", caption: "Inspection tag", image: null },
      ],
    });

    expect(data.sections.find((section) => section.title === "Quality Control")?.photos).toHaveLength(1);
    expect(data.deficiencies).toMatchObject([{ label: "Failed inspection", note: "Correct before drywall.", photos: [{ caption: "Inspection tag" }] }]);

    const pdf = await renderFieldScorecardPdf(data);
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(1_000);
  });

  it("renders a large multi-photo report: caps embedded evidence, embeds images, handles both signature kinds and a long deficiency note", async () => {
    const longNote = "Correct before drywall. ".repeat(300); // ~7200 chars → must be bounded, not overflow
    const data = buildScorecardPdfData({
      dealName: "Harbor Point",
      projectNumber: "DFW-99999",
      weekOf: "2026-07-06",
      superintendentName: "Sam Super",
      pmName: "Pat Manager",
      submittedByName: "Sam Super",
      submittedAt: "2026-07-10T17:00:00.000Z",
      totalScore: 62,
      formVersion: 2,
      averageScore: 6.2,
      rating: "corrective_action",
      // Handwritten super signature (data URL → image), legacy typed PM signature (plain text).
      superintendentSignature: EVIDENCE_PNG_DATA_URL,
      pmSignature: "Pat Q. Manager",
      items: [{ sectionKey: "quality", points: 6, note: "Reinspect framing." }],
      criticalDeficiencyKeys: ["failed_inspection"],
      criticalDeficiencyNotes: { failed_inspection: longNote },
      actionItems: ["Schedule reinspection"],
      // 70 quality photos (mix of embedded + placeholder) → over the 60-tile cap → overflow note page.
      photos: Array.from({ length: 70 }, (_, i) => ({
        sectionKey: "quality" as const,
        deficiencyKey: null,
        caption: i % 2 === 0 ? "Evidence " + i : null,
        image: i % 3 === 0 ? EVIDENCE_PNG : null,
      })),
    });

    const pdf = await renderFieldScorecardPdf(data);
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    // Substantial (multi-page evidence) but not runaway.
    expect(pdf.length).toBeGreaterThan(5_000);
    expect(pdf.length).toBeLessThan(5_000_000);
    // Renders in well under a second in isolation but has been observed near 5s under full-suite parallel
    // load, where it timed out against vitest's default. Give the slowest render in the file real headroom.
  }, 30_000);
});

describe("buildScorecardPdfData omittedEvidenceCount", () => {
  const base = {
    dealName: "X", projectNumber: null, weekOf: "2026-07-06", superintendentName: null, pmName: null,
    submittedByName: null, submittedAt: "2026-07-10T17:00:00.000Z", totalScore: 80, formVersion: 2 as const,
    averageScore: 8, rating: "on_standard" as const, items: [], criticalDeficiencyKeys: [], actionItems: [],
  };

  it("defaults to 0 and passes an upstream (pre-cap) count through, clamping negatives", () => {
    expect(buildScorecardPdfData(base).omittedEvidenceCount).toBe(0);
    expect(buildScorecardPdfData({ ...base, omittedEvidenceCount: 7 }).omittedEvidenceCount).toBe(7);
    expect(buildScorecardPdfData({ ...base, omittedEvidenceCount: -3 }).omittedEvidenceCount).toBe(0);
  });
});

describe("capEvidenceGroups", () => {
  it("keeps every photo when under the cap (omitted = 0)", () => {
    const { groups, omitted } = capEvidenceGroups([group("A", 5), group("B", 3)], 60);
    expect(omitted).toBe(0);
    expect(groups.map((g) => g.photos.length)).toEqual([5, 3]);
  });

  it("trims the group that crosses the cap and reports the omitted count", () => {
    const { groups, omitted } = capEvidenceGroups([group("A", 40), group("B", 40)], 60);
    expect(groups).toHaveLength(2);
    expect(groups[0].photos).toHaveLength(40);
    expect(groups[1].photos).toHaveLength(20);
    expect(omitted).toBe(20);
  });

  it("drops whole groups once the budget is exhausted", () => {
    const { groups, omitted } = capEvidenceGroups([group("A", 60), group("B", 10)], 60);
    expect(groups).toHaveLength(1);
    expect(groups[0].photos).toHaveLength(60);
    expect(omitted).toBe(10);
  });

  it("omits everything when the cap is zero", () => {
    const { groups, omitted } = capEvidenceGroups([group("A", 4)], 0);
    expect(groups).toHaveLength(0);
    expect(omitted).toBe(4);
  });
});

describe("scorecard signature rendering helpers", () => {
  it("decodes a handwritten png/jpeg data URL to image bytes", () => {
    const buf = signatureDataUrlToBuffer(TINY_PNG_DATA_URL);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf!.length).toBeGreaterThan(0);
  });

  it("does not treat a typed name or unsupported data URL as an image", () => {
    expect(signatureDataUrlToBuffer("Pat Q. Manager")).toBeNull();
    expect(signatureDataUrlToBuffer("data:image/gif;base64,AAAA")).toBeNull();
    expect(signatureDataUrlToBuffer(null)).toBeNull();
  });

  it("renders a legacy typed signature as text but never dumps a data URL as text", () => {
    expect(typedSignatureFallback("Pat Q. Manager")).toBe("Pat Q. Manager");
    expect(typedSignatureFallback(TINY_PNG_DATA_URL)).toBeNull();
    expect(typedSignatureFallback(null)).toBeNull();
  });

  it("classifies identically to the shared predicate the web deal tab uses", () => {
    // Both surfaces now route through shared/types/field-scorecard-signature. This locks them together:
    // if they ever disagree, one shows a signature the other renders as an em dash.
    for (const value of [
      TINY_PNG_DATA_URL,
      "Pat Q. Manager",
      "data:image/gif;base64,AAAA",
      "data:image/svg+xml;base64,PHN2Zz4=",
      "data:text/html;base64,PHNjcmlwdD4=",
      "DATA:IMAGE/PNG;BASE64,iVBORw0KGgo=",
      "",
      null,
    ]) {
      expect(signatureDataUrlToBuffer(value) !== null).toBe(isRenderableSignatureDataUrl(value));
      expect(typedSignatureFallback(value)).toBe(sharedTypedSignatureFallback(value));
    }
  });

  it("never renders an unsupported data URL as either an image or verbatim text", () => {
    // The reported bug was a raw `data:image/png;base64,...` printed as text. Neither an unsupported image
    // type nor an uppercase data URL may fall through to the verbatim-text branch.
    for (const value of ["data:image/svg+xml;base64,PHN2Zz4=", "DATA:TEXT/HTML;BASE64,PHNjcmlwdD4="]) {
      expect(signatureDataUrlToBuffer(value)).toBeNull();
      expect(typedSignatureFallback(value)).toBeNull();
    }
  });
});

describe("corrective-action section", () => {
  const base = {
    dealName: "Arboretum at Lewisville",
    projectNumber: "DFW-4-19426-ak",
    weekOf: "2026-07-27",
    superintendentName: "Adnaan Iqbal",
    pmName: "Addy",
    submittedByName: "Adnaan Iqbal",
    submittedAt: "2026-07-27T12:00:00.000Z",
    totalScore: 23,
    formVersion: 2 as const,
    rating: "corrective_action" as const,
    items: [],
    criticalDeficiencyKeys: [],
    actionItems: [],
  };

  function ca(over: Partial<ScorecardPdfCorrectiveAction> & Pick<ScorecardPdfCorrectiveAction, "itemRef">): ScorecardPdfCorrectiveAction {
    return {
      itemType: "action_item",
      itemLabel: `Item ${over.itemRef}`,
      status: "open",
      responderName: null,
      respondedAt: null,
      responseComment: null,
      photos: [],
      ...over,
    };
  }

  it("orders items NUMERICALLY by item_ref, action items before deficiencies", () => {
    // Lexical ordering puts "10" before "2". This must match the deal-thread order.
    const data = buildScorecardPdfData({
      ...base,
      correctiveActions: [
        ca({ itemRef: "10" }),
        ca({ itemRef: "2" }),
        ca({ itemRef: "missed_hold_point", itemType: "critical_deficiency" }),
        ca({ itemRef: "1" }),
      ],
    });

    expect(data.correctiveActions.map((c) => c.itemRef)).toEqual(["1", "2", "10", "missed_hold_point"]);
  });

  it("summarises partial and complete progress", () => {
    const partial = buildScorecardPdfData({
      ...base,
      correctiveActions: [ca({ itemRef: "1", status: "resolved" }), ca({ itemRef: "2" })],
    });
    expect(partial.correctiveActionSummary).toBe("1 of 2 resolved");

    const complete = buildScorecardPdfData({
      ...base,
      correctiveActions: [ca({ itemRef: "1", status: "resolved" })],
    });
    expect(complete.correctiveActionSummary).toBe("All items resolved");

    expect(buildScorecardPdfData({ ...base }).correctiveActionSummary).toBeNull();
  });

  it("caps response photos across the whole report and reports the omitted count", () => {
    const photos = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ caption: `Photo ${i}`, image: null }));
    const data = buildScorecardPdfData({
      ...base,
      correctiveActions: [
        ca({ itemRef: "1", status: "resolved", photos: photos(MAX_CORRECTIVE_ACTION_PHOTOS) }),
        ca({ itemRef: "2", status: "resolved", photos: photos(5) }),
      ],
    });

    // The budget is spent by the first item in render order; the second keeps none.
    expect(data.correctiveActions[0].photos).toHaveLength(MAX_CORRECTIVE_ACTION_PHOTOS);
    expect(data.correctiveActions[1].photos).toHaveLength(0);
    expect(data.omittedCorrectiveActionPhotoCount).toBe(5);
  });

  it("renders a PDF carrying the corrective-action record", async () => {
    const data = buildScorecardPdfData({
      ...base,
      correctiveActions: [
        ca({
          itemRef: "missed_hold_point",
          itemType: "critical_deficiency",
          itemLabel: "Missed hold point",
          status: "resolved",
          responderName: "Addy",
          respondedAt: "2026-07-27T13:00:00.000Z",
          responseComment: "Re-inspected and signed off by the PM.",
          photos: [{ caption: "After", image: EVIDENCE_PNG }],
        }),
        ca({ itemRef: "1", itemLabel: "Still outstanding" }),
      ],
    });

    const pdf = await renderFieldScorecardPdf(data);
    expect(pdf.byteLength).toBeGreaterThan(1000);
  });

  it("renders byte-identically when the card has no corrective actions", async () => {
    // The section must be entirely absent for the vast majority of cards that never go below band.
    const [withoutField, withEmpty] = await Promise.all([
      renderFieldScorecardPdf(buildScorecardPdfData({ ...base })),
      renderFieldScorecardPdf(buildScorecardPdfData({ ...base, correctiveActions: [] })),
    ]);
    expect(withEmpty.byteLength).toBe(withoutField.byteLength);
  });

  it("survives a long comment and an undecodable response photo", async () => {
    const data = buildScorecardPdfData({
      ...base,
      correctiveActions: [
        ca({
          itemRef: "1",
          status: "resolved",
          responderName: "Addy",
          respondedAt: "2026-07-27T13:00:00.000Z",
          responseComment: "Re-poured and cured. ".repeat(400),
          photos: [{ caption: "Corrupt", image: Buffer.from("not an image") }],
        }),
      ],
    });

    const pdf = await renderFieldScorecardPdf(data);
    expect(pdf.byteLength).toBeGreaterThan(1000);
  });
});


/**
 * Every text-positioning y-coordinate in the document's content streams, in PDF user space (bottom-left
 * origin, so the 48pt bottom margin is y = 48 and anything lower has overflowed the printable area).
 * PDFKit Flate-compresses its content streams, so they must be inflated before the operators are visible.
 */
function textYPositions(pdf: Buffer): number[] {
  const raw = pdf.toString("latin1");
  const ys: number[] = [];
  const streamRe = /stream\r?\n/g;
  let match: RegExpExecArray | null;
  while ((match = streamRe.exec(raw)) !== null) {
    const start = match.index + match[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) continue;
    const body = Buffer.from(raw.slice(start, end), "latin1");
    let text: string;
    try {
      text = inflateSync(body).toString("latin1");
    } catch {
      continue; // not a Flate stream (e.g. an embedded image) — skip it.
    }
    for (const tm of text.matchAll(/1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm/g)) {
      ys.push(Number(tm[2]));
    }
  }
  return ys;
}

describe("corrective-action page-break safety", () => {
  const base = {
    dealName: "Harbor Point",
    projectNumber: "DFW-99999",
    weekOf: "2026-07-27",
    superintendentName: "Sam Super",
    pmName: "Pat Manager",
    submittedByName: "Sam Super",
    submittedAt: "2026-07-27T12:00:00.000Z",
    totalScore: 23,
    formVersion: 2 as const,
    rating: "corrective_action" as const,
    items: [],
    criticalDeficiencyKeys: [] as string[],
    actionItems: [] as string[],
  };

  /**
   * PDFKit disables auto-pagination for text drawn with an explicit `height`, which the response comment
   * uses to bound a long dictation. An under-reserved page-break guard therefore lets the comment flow past
   * the bottom margin to the page edge and drops the trailing hairline outside the media box.
   *
   * Walk the whole section with many resolved items carrying long comments — every item lands at a
   * different starting y, so this sweeps the vulnerable window rather than guessing one offset.
   */
  it("never draws a response comment past the bottom margin", async () => {
    const data = buildScorecardPdfData({
      ...base,
      correctiveActions: Array.from({ length: 14 }, (_, i) => ({
        itemType: "action_item",
        itemRef: String(i),
        itemLabel: `Corrective item ${i}`,
        status: "resolved",
        responderName: "Pat Manager",
        respondedAt: "2026-07-27T13:00:00.000Z",
        // ~500 chars: long enough to fill the bounded comment box.
        responseComment: "Re-poured and cured, then re-inspected with the safety lead. ".repeat(9),
        photos: [],
      })),
    });

    const pdf = await renderFieldScorecardPdf(data);

    // Every text-positioning operator in the content streams must sit inside the printable area. PDF user
    // space is bottom-left origin, so the 48pt bottom margin is y = 48; anything below that has overflowed.
    const yPositions = textYPositions(pdf);
    expect(yPositions.length).toBeGreaterThan(20);
    expect(yPositions.filter((y) => y < 48)).toEqual([]);
  });

  it("never draws a response comment past the bottom margin for a mix of open and resolved items", async () => {
    const data = buildScorecardPdfData({
      ...base,
      correctiveActions: Array.from({ length: 20 }, (_, i) => ({
        itemType: "action_item",
        itemRef: String(i),
        itemLabel: `Item ${i}`,
        status: i % 3 === 0 ? "open" : "resolved",
        responderName: i % 3 === 0 ? null : "Pat Manager",
        respondedAt: i % 3 === 0 ? null : "2026-07-27T13:00:00.000Z",
        responseComment: i % 3 === 0 ? null : "Corrected on site and verified. ".repeat(12),
        photos: [],
      })),
    });

    const pdf = await renderFieldScorecardPdf(data);
    const yPositions = textYPositions(pdf);
    expect(yPositions.length).toBeGreaterThan(20);
    expect(yPositions.filter((y) => y < 48)).toEqual([]);
  });

  it("adds an upstream pre-cap omission to the render-side count", async () => {
    // The artifact job caps response photos BEFORE downloading bytes (so a photo beyond the cap cannot 503
    // the whole download). Its omitted count must reach the "available in the CRM" note, or the note would
    // report only what this render discarded.
    const data = buildScorecardPdfData({
      ...base,
      omittedCorrectiveActionPhotoCount: 7,
      correctiveActions: [
        {
          itemType: "action_item",
          itemRef: "0",
          itemLabel: "Item",
          status: "resolved",
          responderName: "Pat",
          respondedAt: "2026-07-27T13:00:00.000Z",
          responseComment: "done",
          photos: [{ caption: "a", image: null }],
        },
      ],
    });

    expect(data.omittedCorrectiveActionPhotoCount).toBe(7);
    expect(data.correctiveActions[0].photos).toHaveLength(1);
  });
});
