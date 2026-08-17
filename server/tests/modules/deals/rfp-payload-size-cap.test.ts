import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RFP_BODY_BYTE_BUDGET,
  SYNCHUB_JSON_BODY_LIMIT_BYTES,
  buildNormalizedRfpRequestBody,
  capRfpRequestBody,
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

describe("cap performance and priority", () => {
  it("stays linear in attachment count instead of reserializing per removal", () => {
    // The pop-and-reserialize loop was O(n^2): 2,000 oversized attachments meant ~1,900 full JSON
    // serializations of a ~1.7MB payload, blocking the event loop while the tenant transaction is
    // open — precisely on the file-heavy inputs this cap targets.
    const attachments = Array.from({ length: 4000 }, (_, i) => makeAttachment(i));

    const started = process.hrtime.bigint();
    const body = buildNormalizedRfpRequestBody({
      deal: baseDeal,
      sourceEventId: "crm:deal-stage:opportunity:evt-1",
      attachments,
    });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(bodyBytes(body)).toBeLessThanOrEqual(SYNCHUB_JSON_BODY_LIMIT_BYTES);
    expect(body.attachmentsOmitted).toBe(4000 - body.attachments.length);
    // Quadratic behaviour takes seconds here; linear is milliseconds. Generous bound to stay stable
    // on slow CI without being satisfiable by the old implementation.
    expect(elapsedMs).toBeLessThan(1000);
  });

  it("sacrifices oversized deal fields before dropping the protected photo share link", () => {
    // The link is the ONLY route to a collapsed deal's photos, so a pathological `estimator` must
    // not be what evicts it.
    const shareLink = {
      name: "Project Photos (250)",
      url: "https://crm.example.com/p/tok-abc",
      contentType: "text/html",
    };

    const body = buildNormalizedRfpRequestBody({
      deal: { ...baseDeal, estimator: "E".repeat(200_000) },
      sourceEventId: "crm:deal-stage:opportunity:evt-1",
      attachments: [shareLink, ...Array.from({ length: 200 }, (_, i) => makeAttachment(i))],
      protectedAttachmentCount: 1,
    });

    expect(bodyBytes(body)).toBeLessThanOrEqual(SYNCHUB_JSON_BODY_LIMIT_BYTES);
    expect(body.attachments[0]).toEqual(shareLink);
    expect(body.deal.estimator).toBeNull();
  });
});

describe("crmActivityLog is the FIRST thing surrendered", () => {
  // The limiter warns when it drops the log; keep that out of the suite's output but keep it assertable.
  let warned: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warned = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The activity log is a second unbounded input alongside the description, and it is the most
  // expendable field in the body: purely informational, with the full history one click away in the
  // CRM. Its build-time caps (MAX_NOTE_CHARS = 8000) mean the limiter is a backstop here rather than
  // the normal path — these fixtures deliberately exceed those caps to exercise it.

  it("drops the log WHOLE and leaves the description untouched when that is enough", () => {
    const description = "D".repeat(20_000);
    const body = buildNormalizedRfpRequestBody({
      deal: { ...baseDeal, description, crmActivityLog: "A".repeat(80_000) },
      sourceEventId: "crm:deal-stage:opportunity:evt-1",
      attachments: [],
    });

    expect(bodyBytes(body)).toBeLessThanOrEqual(RFP_BODY_BYTE_BUDGET);
    expect(body.deal.crmActivityLog).toBeNull();
    // The ordering assertion: byte-for-byte intact, no "truncated" marker. If the log were left to
    // SACRIFICIAL_DEAL_FIELDS, the description shrink would run first and mangle the deal's actual
    // scope in order to preserve an activity log — backwards.
    expect(body.deal.description).toBe(description);
    expect(body.deal.description).not.toContain("truncated");
  });

  it("still shrinks the description when the description ALONE is what blows the budget", () => {
    // Control for the test above: proves the description shrink is live, so "description intact"
    // there really is the log's removal doing the work.
    const body = buildNormalizedRfpRequestBody({
      deal: { ...baseDeal, description: "D".repeat(200_000), crmActivityLog: null },
      sourceEventId: "crm:deal-stage:opportunity:evt-1",
      attachments: [],
    });

    expect(bodyBytes(body)).toBeLessThanOrEqual(RFP_BODY_BYTE_BUDGET);
    expect(body.deal.description).toContain("truncated");
  });

  it("bounds the body when the log alone is pathological", () => {
    const body = buildNormalizedRfpRequestBody({
      deal: { ...baseDeal, crmActivityLog: "A".repeat(200_000) },
      sourceEventId: "crm:deal-stage:opportunity:evt-1",
      attachments: [],
    });

    expect(bodyBytes(body)).toBeLessThanOrEqual(RFP_BODY_BYTE_BUDGET);
    expect(body.deal.crmActivityLog).toBeNull();
  });

  it("says so when it drops the log", () => {
    // Unlike attachmentsOmitted there is no field on the wire carrying this, so without a log line
    // "why did this Bid Board project get no note?" has no answer anywhere.
    buildNormalizedRfpRequestBody({
      deal: { ...baseDeal, crmActivityLog: "A".repeat(200_000) },
      sourceEventId: "crm:deal-stage:opportunity:evt-1",
      attachments: [],
    });

    expect(warned).toHaveBeenCalledTimes(1);
    const message = String(warned.mock.calls[0]![0]);
    expect(message).toContain("crmActivityLog");
    expect(message).toContain(baseDeal.id); // identifies WHICH deal lost its note
  });

  it("stays silent when the log survives", () => {
    buildNormalizedRfpRequestBody({
      deal: { ...baseDeal, crmActivityLog: "short note" },
      sourceEventId: "crm:deal-stage:opportunity:evt-1",
      attachments: [],
    });
    expect(warned).not.toHaveBeenCalled();
  });

  it("keeps the log when the body already fits", () => {
    const note = "CRM Activity Log — 25-1234 (as of Aug 17, 2026)\n\nAug 14, 2026 · Call · Jane Rep\n  Scope confirmed.";
    const body = buildNormalizedRfpRequestBody({
      deal: { ...baseDeal, crmActivityLog: note },
      sourceEventId: "crm:deal-stage:opportunity:evt-1",
      attachments: [makeAttachment(0)],
    });

    expect(body.deal.crmActivityLog).toBe(note);
  });

  it("gives up the log before evicting a single attachment", () => {
    // Attachments are the reviewer's actual documents; a display extra must never be what pushes one
    // of them off the list.
    const attachments = Array.from({ length: 100 }, (_, i) => makeAttachment(i));

    // Size the log off the MEASURED headroom rather than guessing: exactly big enough that the body
    // is over budget with it and under budget without it.
    const withoutLog = buildNormalizedRfpRequestBody({
      deal: baseDeal,
      sourceEventId: "crm:deal-stage:opportunity:evt-1",
      attachments,
    });
    expect(withoutLog.attachments).toHaveLength(100);
    const headroom = RFP_BODY_BYTE_BUDGET - bodyBytes(withoutLog);
    expect(headroom).toBeGreaterThan(0);

    const body = buildNormalizedRfpRequestBody({
      deal: { ...baseDeal, crmActivityLog: "A".repeat(headroom + 1_000) },
      sourceEventId: "crm:deal-stage:opportunity:evt-1",
      attachments,
    });

    expect(bodyBytes(body)).toBeLessThanOrEqual(RFP_BODY_BYTE_BUDGET);
    expect(body.deal.crmActivityLog).toBeNull();
    expect(body.attachments).toHaveLength(100);
    expect(body.attachmentsOmitted).toBe(0);
  });
});

describe("capRfpRequestBody (retry path)", () => {
  beforeEach(() => {
    // The re-cap path can drop the activity log too, which warns; keep the suite output clean.
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("re-caps a body whose attachments were swapped in after the original pass", () => {
    // The retry route splices freshly-minted attachment URLs into the DEAD job's already-capped
    // body. Without re-running the limiter, a deal whose file set grew since the original enqueue
    // re-enqueues an oversized body and the worker immediately dead-letters it with another 413.
    const original = buildNormalizedRfpRequestBody({
      deal: baseDeal,
      sourceEventId: "crm:deal-stage:opportunity:evt-1",
      attachments: [makeAttachment(0)],
    });

    const recapped = capRfpRequestBody({
      ...original,
      attachments: Array.from({ length: 400 }, (_, i) => makeAttachment(i)),
    });

    expect(bodyBytes(recapped)).toBeLessThanOrEqual(SYNCHUB_JSON_BODY_LIMIT_BYTES);
    expect(recapped.attachments.length).toBeLessThan(400);
    expect(recapped.attachmentsOmitted).toBe(400 - recapped.attachments.length);
  });

  it("recomputes attachmentsOmitted rather than inheriting the dead job's stale count", () => {
    const stale = buildNormalizedRfpRequestBody({
      deal: baseDeal,
      sourceEventId: "crm:deal-stage:opportunity:evt-1",
      attachments: Array.from({ length: 400 }, (_, i) => makeAttachment(i)),
    });
    expect(stale.attachmentsOmitted).toBeGreaterThan(0);

    const recapped = capRfpRequestBody({ ...stale, attachments: [makeAttachment(0)] });

    expect(recapped.attachmentsOmitted).toBe(0);
    expect(recapped.attachments).toHaveLength(1);
  });

  it("carries crmActivityLog through the shallow clone, and still drops it first", () => {
    const original = buildNormalizedRfpRequestBody({
      deal: { ...baseDeal, crmActivityLog: "kept" },
      sourceEventId: "crm:deal-stage:opportunity:evt-1",
      attachments: [makeAttachment(0)],
    });
    expect(original.deal.crmActivityLog).toBe("kept");

    // Under budget: the field survives the re-cap untouched.
    expect(capRfpRequestBody(original).deal.crmActivityLog).toBe("kept");

    // Over budget: it is the first thing surrendered, exactly as on the build path.
    const recapped = capRfpRequestBody({
      ...original,
      deal: { ...original.deal, crmActivityLog: "A".repeat(200_000) },
      attachments: [makeAttachment(0)],
    });
    expect(recapped.deal.crmActivityLog).toBeNull();
    expect(bodyBytes(recapped)).toBeLessThanOrEqual(RFP_BODY_BYTE_BUDGET);
  });

  it("round-trips a stored body that predates the field without inventing one", () => {
    // The retry route feeds us a body read back out of job_queue. A dead job enqueued before this
    // field existed simply has no key — it must stay absent, never become the string "undefined".
    const stored = buildNormalizedRfpRequestBody({
      deal: baseDeal,
      sourceEventId: "crm:deal-stage:opportunity:evt-1",
      attachments: [makeAttachment(0)],
    });
    const legacyDeal = { ...stored.deal } as Record<string, unknown>;
    delete legacyDeal.crmActivityLog;
    const legacy = { ...stored, deal: legacyDeal } as unknown as typeof stored;

    const recapped = capRfpRequestBody(legacy);

    expect("crmActivityLog" in recapped.deal).toBe(false);
    expect(JSON.stringify(recapped)).not.toContain("crmActivityLog");
    expect(bodyBytes(recapped)).toBeLessThanOrEqual(RFP_BODY_BYTE_BUDGET);
  });

  it("does not mutate the body it was given", () => {
    const original = buildNormalizedRfpRequestBody({
      deal: { ...baseDeal, description: "S".repeat(200_000) },
      sourceEventId: "crm:deal-stage:opportunity:evt-1",
      attachments: [makeAttachment(0)],
    });
    const before = JSON.stringify(original);

    capRfpRequestBody({ ...original, attachments: Array.from({ length: 400 }, (_, i) => makeAttachment(i)) });

    expect(JSON.stringify(original)).toBe(before);
  });
});
