import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildScorecardPdfData,
  capEvidenceGroups,
  renderFieldScorecardPdf,
  signatureDataUrlToBuffer,
  typedSignatureFallback,
  type EvidenceGroup,
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
  });
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
