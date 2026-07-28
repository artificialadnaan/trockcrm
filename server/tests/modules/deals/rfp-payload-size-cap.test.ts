import { describe, expect, it } from "vitest";
import {
  RFP_BODY_BYTE_BUDGET,
  SYNCHUB_JSON_BODY_LIMIT_BYTES,
  buildNormalizedRfpRequestBody,
} from "../../../src/modules/deals/rfp-payload.js";

/**
 * TRK-2607-H3X6. SyncHub parses POST /api/rfp-requests (and /api/bid-board/create-from-rfp)
 * with express.json() at the body-parser DEFAULT limit — measured against prod as exactly
 * 102400 bytes. The CRM used to map EVERY active deal file into `attachments` with an ~800-byte
 * presigned URL each and no cap, so a file-heavy deal produced a body over the wall. SyncHub
 * rejected it at the parser, BEFORE the signature check, with a 413 whose message its production
 * error middleware masked to "Internal server error" — surfacing on the deal as
 * "RFP delivery failed with 413: Internal server error", and leaving the deal stuck because the
 * approval callback that advances it to service_estimating never fired.
 *
 * The body must therefore be self-limiting: it can never exceed what SyncHub will parse.
 */

const baseDeal = {
  id: "3f2b1a0c-1111-4222-8333-444455556666",
  name: "Sunrise Medical Center - Roof Replacement",
  dealNumber: "25-1234",
  projectNumber: "25-1234",
  projectType: "service",
  workflowRoute: "service" as const,
  awardedAmount: 482000,
  companyName: "Sunrise Healthcare Partners LLC",
  contactName: "Dana Whitfield",
  clientEmail: "dana@example.com",
  clientPhone: "+1 555 0134",
  propertyAddress: "4820 North Industrial Parkway",
  propertyCity: "Oklahoma City",
  propertyState: "OK",
  propertyZip: "73142",
  propertyCountry: "US",
  description: null as string | null,
};

/** Mirrors a real presigned R2 GET URL (7-day SigV4), ~760 chars. */
function makeAttachment(index: number) {
  return {
    name: `Drawing Set ${String(index).padStart(3, "0")}.pdf`,
    url:
      `https://a1b2c3d4.r2.cloudflarestorage.com/trock-crm-files/office_trock/deals/25-1234/documents/` +
      `550e8400-e29b-41d4-a716-4466554400${String(index % 100).padStart(2, "0")}-Drawing-Set.pdf` +
      `?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD` +
      `&X-Amz-Credential=0123456789abcdef0123456789abcdef%2F20260728%2Fauto%2Fs3%2Faws4_request` +
      `&X-Amz-Date=20260728T000000Z&X-Amz-Expires=604800&X-Amz-SignedHeaders=host` +
      `&X-Amz-Signature=${"a".repeat(64)}` +
      `&x-id=GetObject${"&pad=".padEnd(120, "p")}`,
    contentType: "application/pdf",
  };
}

function bodyBytes(body: unknown): number {
  return Buffer.byteLength(JSON.stringify(body));
}

describe("RFP request body stays within SyncHub's parser limit", () => {
  it("exposes SyncHub's real 100kb parser limit and a budget below it", () => {
    expect(SYNCHUB_JSON_BODY_LIMIT_BYTES).toBe(102400);
    expect(RFP_BODY_BYTE_BUDGET).toBeLessThan(SYNCHUB_JSON_BODY_LIMIT_BYTES);
  });

  it("keeps every attachment and reports no omissions when the body already fits", () => {
    const attachments = Array.from({ length: 10 }, (_, i) => makeAttachment(i));

    const body = buildNormalizedRfpRequestBody({
      deal: baseDeal,
      sourceEventId: "crm:deal-stage:opportunity:evt-1",
      attachments,
    });

    expect(body.attachments).toHaveLength(10);
    expect(body.attachmentsOmitted).toBe(0);
    expect(bodyBytes(body)).toBeLessThanOrEqual(RFP_BODY_BYTE_BUDGET);
  });

  it("drops the oldest attachments and reports the count when a file-heavy deal would blow the limit", () => {
    // 300 attachments ≈ 240KB — well past the wall that produced the 413 on the ticket.
    const attachments = Array.from({ length: 300 }, (_, i) => makeAttachment(i));

    const body = buildNormalizedRfpRequestBody({
      deal: baseDeal,
      sourceEventId: "crm:deal-stage:opportunity:evt-1",
      attachments,
    });

    expect(bodyBytes(body)).toBeLessThanOrEqual(SYNCHUB_JSON_BODY_LIMIT_BYTES);
    expect(body.attachments.length).toBeGreaterThan(0);
    expect(body.attachments.length).toBeLessThan(300);
    expect(body.attachmentsOmitted).toBe(300 - body.attachments.length);
    // Callers pass newest-first, so the retained set must be the LEADING slice.
    expect(body.attachments).toEqual(attachments.slice(0, body.attachments.length));
  });

  it("truncates a pathologically long description rather than emitting an unparseable body", () => {
    const body = buildNormalizedRfpRequestBody({
      deal: { ...baseDeal, description: "S".repeat(200_000) },
      sourceEventId: "crm:deal-stage:opportunity:evt-1",
      attachments: [],
    });

    expect(bodyBytes(body)).toBeLessThanOrEqual(SYNCHUB_JSON_BODY_LIMIT_BYTES);
    expect(body.deal.description).toContain("truncated");
  });

  // `estimator`, `property_address`, `property_country`, `project_type` and `project_number` are all
  // unbounded `text` columns. Shrinking only the description and the attachment list therefore did NOT
  // make the cap total: once both were exhausted the body was returned oversized and SyncHub 413'd it
  // anyway — the very failure this cap exists to prevent.
  it.each([
    ["estimator", { estimator: "E".repeat(200_000) }],
    ["propertyAddress", { propertyAddress: "A".repeat(200_000) }],
    ["propertyCountry", { propertyCountry: "C".repeat(200_000) }],
    ["companyName", { companyName: "N".repeat(200_000) }],
  ])("bounds the body when the unbounded text field %s is pathological", (_label, overrides) => {
    const body = buildNormalizedRfpRequestBody({
      deal: { ...baseDeal, ...(overrides as object) },
      sourceEventId: "crm:deal-stage:opportunity:evt-1",
      attachments: [],
    });

    expect(bodyBytes(body)).toBeLessThanOrEqual(SYNCHUB_JSON_BODY_LIMIT_BYTES);
  });

  it("bounds the body when a REQUIRED text field is pathological, while keeping it non-empty", () => {
    // name/projectNumber/projectType are `.min(1)` in SyncHub's zod — clamping them must not empty
    // them out, or we would trade a 413 for a 422.
    const body = buildNormalizedRfpRequestBody({
      deal: {
        ...baseDeal,
        name: "N".repeat(200_000),
        projectNumber: "P".repeat(200_000),
        dealNumber: "P".repeat(200_000),
      },
      sourceEventId: "crm:deal-stage:opportunity:evt-1",
      attachments: [],
    });

    expect(bodyBytes(body)).toBeLessThanOrEqual(SYNCHUB_JSON_BODY_LIMIT_BYTES);
    expect(body.deal.name.length).toBeGreaterThan(0);
    expect(body.deal.projectNumber.length).toBeGreaterThan(0);
    expect(body.deal.projectType.length).toBeGreaterThan(0);
    expect(body.sourceDealId.length).toBeGreaterThan(0);
    expect(body.sourceEventId.length).toBeGreaterThan(0);
  });

  it("never exceeds the limit even when every unbounded input is oversized at once", () => {
    const body = buildNormalizedRfpRequestBody({
      deal: {
        ...baseDeal,
        name: "N".repeat(120_000),
        description: "S".repeat(120_000),
        estimator: "E".repeat(120_000),
        propertyAddress: "A".repeat(120_000),
        propertyCountry: "C".repeat(120_000),
        companyName: "M".repeat(120_000),
        contactName: "T".repeat(120_000),
      },
      sourceEventId: "crm:deal-stage:opportunity:evt-1",
      attachments: Array.from({ length: 300 }, (_, i) => makeAttachment(i)),
    });

    expect(bodyBytes(body)).toBeLessThanOrEqual(SYNCHUB_JSON_BODY_LIMIT_BYTES);
  });

  it("never exceeds the limit even when description AND attachments are both oversized", () => {
    const body = buildNormalizedRfpRequestBody({
      deal: { ...baseDeal, description: "S".repeat(200_000) },
      sourceEventId: "crm:deal-stage:opportunity:evt-1",
      attachments: Array.from({ length: 300 }, (_, i) => makeAttachment(i)),
    });

    expect(bodyBytes(body)).toBeLessThanOrEqual(SYNCHUB_JSON_BODY_LIMIT_BYTES);
  });
});
