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

  it("uses an explicit change-order FK as the strongest signal for non-images", () => {
    expect(inferFileCategory({ filename: "scan001.pdf", mimeType: "application/pdf", changeOrderId: "co-1" })).toBe(
      "change_order"
    );
  });

  it("weighs folder path / subcategory above the filename", () => {
    // folder says contracts, filename is generic -> contract
    expect(
      inferFileCategory({ filename: "doc1.pdf", mimeType: "application/pdf", folderPath: "Contracts/2026" })
    ).toBe("contract");
    // subcategory hint wins over a generic filename
    expect(
      inferFileCategory({ filename: "final.pdf", mimeType: "application/pdf", subcategory: "Permit" })
    ).toBe("permit");
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
