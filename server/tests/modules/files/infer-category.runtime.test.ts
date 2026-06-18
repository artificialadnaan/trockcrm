import { describe, expect, it } from "vitest";
import { FILE_CATEGORIES } from "@trock-crm/shared/types";
import { inferFileCategory } from "../../../src/modules/files/infer-category.js";

const VALID = new Set<string>(FILE_CATEGORIES);

describe("inferFileCategory", () => {
  it("classifies images as photo regardless of doc keywords in the name (image precedence)", () => {
    expect(inferFileCategory({ filename: "site.jpg", mimeType: "image/jpeg" })).toBe("photo");
    expect(inferFileCategory({ filename: "contract.jpg", mimeType: "image/jpeg" })).toBe("photo");
    expect(inferFileCategory({ filename: "scan.PNG", mimeType: "application/octet-stream" })).toBe("photo");
    expect(inferFileCategory({ filename: "roof.heic", mimeType: "" })).toBe("photo");
    // image even when an explicit change-order link is present
    expect(
      inferFileCategory({ filename: "co-photo.jpg", mimeType: "image/jpeg", changeOrderId: "co-1" })
    ).toBe("photo");
  });

  it("maps document keywords to the right enum member (non-image)", () => {
    const pdf = "application/pdf";
    expect(inferFileCategory({ filename: "Master Contract.pdf", mimeType: pdf })).toBe("contract");
    expect(inferFileCategory({ filename: "service-agreement.pdf", mimeType: pdf })).toBe("contract");
    expect(inferFileCategory({ filename: "RFP-2026-014.pdf", mimeType: pdf })).toBe("rfp");
    expect(inferFileCategory({ filename: "Request For Proposal.docx", mimeType: pdf })).toBe("rfp");
    expect(inferFileCategory({ filename: "Estimate_v2.pdf", mimeType: pdf })).toBe("estimate");
    expect(inferFileCategory({ filename: "client quote.pdf", mimeType: pdf })).toBe("estimate");
    expect(inferFileCategory({ filename: "Proposal.pdf", mimeType: pdf })).toBe("proposal");
    expect(inferFileCategory({ filename: "CO-3 revised.pdf", mimeType: pdf })).toBe("change_order");
    expect(inferFileCategory({ filename: "Change Order 5.pdf", mimeType: pdf })).toBe("change_order");
    expect(inferFileCategory({ filename: "building permit.pdf", mimeType: pdf })).toBe("permit");
    expect(inferFileCategory({ filename: "final inspection.pdf", mimeType: pdf })).toBe("inspection");
    expect(inferFileCategory({ filename: "punch-list.pdf", mimeType: pdf })).toBe("inspection");
    expect(inferFileCategory({ filename: "COI.pdf", mimeType: pdf })).toBe("insurance");
    expect(inferFileCategory({ filename: "Certificate of Insurance.pdf", mimeType: pdf })).toBe("insurance");
    expect(inferFileCategory({ filename: "warranty.pdf", mimeType: pdf })).toBe("warranty");
    expect(inferFileCategory({ filename: "project closeout.pdf", mimeType: pdf })).toBe("closeout");
    expect(inferFileCategory({ filename: "as-built.pdf", mimeType: pdf })).toBe("closeout");
    expect(inferFileCategory({ filename: "cover letter.pdf", mimeType: pdf })).toBe("correspondence");
  });

  it("treats request-for-proposal as rfp, not proposal (rule precedence)", () => {
    expect(inferFileCategory({ filename: "request-for-proposal-response.pdf", mimeType: "application/pdf" })).toBe("rfp");
  });

  it("matches underscore-delimited filenames (the system's own naming uses underscores)", () => {
    const pdf = "application/pdf";
    expect(inferFileCategory({ filename: "rfp_2026_014.pdf", mimeType: pdf })).toBe("rfp");
    expect(inferFileCategory({ filename: "coi_acme.pdf", mimeType: pdf })).toBe("insurance");
    expect(inferFileCategory({ filename: "msa_v2.pdf", mimeType: pdf })).toBe("contract");
    expect(inferFileCategory({ filename: "deal_co_3.pdf", mimeType: pdf })).toBe("change_order");
  });

  it("covers the remaining keyword forms (SOW / scope of work / O&M / CO#)", () => {
    const pdf = "application/pdf";
    expect(inferFileCategory({ filename: "SOW.pdf", mimeType: pdf })).toBe("contract");
    expect(inferFileCategory({ filename: "Scope of Work.pdf", mimeType: pdf })).toBe("contract");
    expect(inferFileCategory({ filename: "O & M Manual.pdf", mimeType: pdf })).toBe("closeout");
    expect(inferFileCategory({ filename: "CO#5.pdf", mimeType: pdf })).toBe("change_order");
  });

  it("uses an explicit change-order FK as the strongest signal for non-images", () => {
    expect(inferFileCategory({ filename: "scan001.pdf", mimeType: "application/pdf", changeOrderId: "co-1" })).toBe(
      "change_order"
    );
  });

  it("weighs the subcategory hint above the filename", () => {
    // subcategory hint wins over a generic filename
    expect(
      inferFileCategory({ filename: "final.pdf", mimeType: "application/pdf", subcategory: "Permit" })
    ).toBe("permit");
    // surrounding whitespace on the subcategory hint is tolerated (trimmed, like the filename)
    expect(
      inferFileCategory({ filename: "final.pdf", mimeType: "application/pdf", subcategory: "  Permit  " })
    ).toBe("permit");
  });

  it("matches 'contract' as a whole word, not the 'contractor' prefix", () => {
    const pdf = "application/pdf";
    // 'contractor estimate' must resolve to estimate, not contract (the \bcontracts?\b rule no longer
    // matches the 'contractor' prefix).
    expect(inferFileCategory({ filename: "contractor estimate.pdf", mimeType: pdf })).toBe("estimate");
    expect(inferFileCategory({ filename: "general contractor quote.pdf", mimeType: pdf })).toBe("estimate");
    // real contracts still match
    expect(inferFileCategory({ filename: "Master Contract.pdf", mimeType: pdf })).toBe("contract");
    expect(inferFileCategory({ filename: "service contracts.pdf", mimeType: pdf })).toBe("contract");
  });

  it("does not over-match the 'CO' abbreviation (co-op / company are not change orders)", () => {
    const pdf = "application/pdf";
    // 'co-op-agreement' matches 'agreement' → contract (NOT change_order); the change_order CO patterns
    // require co+separator+digit or a literal '#'.
    expect(inferFileCategory({ filename: "co-op-agreement.pdf", mimeType: pdf })).toBe("contract");
    expect(inferFileCategory({ filename: "co-op.pdf", mimeType: pdf })).toBe("other");
    expect(inferFileCategory({ filename: "company-profile.pdf", mimeType: pdf })).toBe("other");
  });

  it("falls back to other for unknown / unmapped types", () => {
    const pdf = "application/pdf";
    // generated photo reports (subcategory 'Photo Report') have no enum -> other
    expect(inferFileCategory({ filename: "Daily Photo Report.pdf", mimeType: pdf, subcategory: "Photo Report" })).toBe(
      "other"
    );
    // no drawing/plan enum -> CAD files are other
    expect(inferFileCategory({ filename: "floorplan.dwg", mimeType: "application/acad" })).toBe("other");
    expect(inferFileCategory({ filename: "random.pdf", mimeType: pdf })).toBe("other");
    expect(inferFileCategory({ filename: "notes.txt", mimeType: "text/plain" })).toBe("other");
    // double NON-image extension resolves on the final ext (pdf) and has no keyword -> other
    expect(inferFileCategory({ filename: "report.final.pdf", mimeType: pdf })).toBe("other");
  });

  it("never throws and always returns a valid enum member on edge inputs", () => {
    const edgeInputs: Parameters<typeof inferFileCategory>[0][] = [
      {},
      { filename: "" },
      { filename: "noextension", mimeType: "" },
      { filename: "double.ext.pdf", mimeType: "application/pdf" },
      { filename: "weird..pdf", mimeType: null, subcategory: null, folderPath: null, changeOrderId: null },
      { filename: "  Contract .pdf  ", mimeType: "application/pdf" },
      { mimeType: "image/png" },
    ];
    for (const input of edgeInputs) {
      const result = inferFileCategory(input);
      expect(VALID.has(result)).toBe(true);
    }
    // trimmed-name keyword still matches
    expect(inferFileCategory({ filename: "  Contract .pdf  ", mimeType: "application/pdf" })).toBe("contract");
    // double extension resolves on the final extension (not an image)
    expect(inferFileCategory({ filename: "photo.pdf.jpg", mimeType: "application/pdf" })).toBe("photo");
  });
});
