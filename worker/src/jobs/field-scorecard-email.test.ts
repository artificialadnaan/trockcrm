import { describe, it, expect, vi } from "vitest";
import { buildFieldScorecardEmail, handleFieldScorecardEmail, type FieldScorecardEmailPayload } from "./field-scorecard-email.js";

function payload(overrides: Partial<FieldScorecardEmailPayload> = {}): FieldScorecardEmailPayload {
  return {
    tenantSchema: "office_dallas",
    scorecardId: "11111111-1111-1111-1111-111111111111",
    dealId: "22222222-2222-2222-2222-222222222222",
    dealName: "Maple Street Tower",
    projectNumber: "DFW-10432",
    weekOf: "2026-06-30",
    totalScore: 82,
    ratingLabel: "Needs Immediate Improvement",
    submittedByName: "Sam Super",
    pdfR2Key: "office_dallas/deals/DFW-10432/documents/scorecards/sc.pdf",
    officeId: "33333333-3333-3333-3333-333333333333",
    ...overrides,
  };
}

// A query mock that answers the SELECT (email_sent_at) and records the UPDATE.
function makeQuery(sentAt: string | null | "notfound") {
  const calls: { sql: string; params: unknown[] }[] = [];
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    if (/SELECT/i.test(sql)) {
      return { rows: sentAt === "notfound" ? [] : [{ email_sent_at: sentAt }] };
    }
    return { rows: [] }; // UPDATE
  });
  return { query: query as any, calls };
}
const PROD = { NODE_ENV: "production", FIELD_SCORECARD_EMAIL_RECIPIENTS: "ops@trock.com" } as unknown as NodeJS.ProcessEnv;
const silent = { log: () => {}, warn: () => {}, error: () => {} };

describe("buildFieldScorecardEmail", () => {
  it("subject carries the project number + score + rating; body has the deal + attached-PDF note", () => {
    const email = buildFieldScorecardEmail({
      dealId: "d1", dealName: "Maple", projectNumber: "DFW-10432", weekOf: "2026-06-30",
      totalScore: 82, ratingLabel: "Needs Immediate Improvement", submittedByName: "Sam",
      pdfStatus: "attached", officeId: "off-1", frontendUrl: "https://trockcrm.com",
    });
    expect(email.subject).toContain("DFW-10432");
    expect(email.subject).toContain("82/100");
    expect(email.html).toContain("Maple");
    expect(email.text).toContain("attached as a PDF");
    expect(email.dealUrl).toBe("https://trockcrm.com/deals/d1?officeId=off-1");
  });

  it("notes the PDF is still generating when it's not yet available", () => {
    const email = buildFieldScorecardEmail({
      dealId: "d1", dealName: "Maple", projectNumber: null, weekOf: null, totalScore: null,
      ratingLabel: null, submittedByName: null, pdfStatus: "unavailable", frontendUrl: "https://trockcrm.com",
    });
    expect(email.text).toContain("still generating");
    expect(email.subject).toContain("Maple");
  });

  it("notes an oversized PDF is available in the CRM (not 'still generating')", () => {
    const email = buildFieldScorecardEmail({
      dealId: "d1", dealName: "Maple", projectNumber: null, weekOf: null, totalScore: null,
      ratingLabel: null, submittedByName: null, pdfStatus: "too_large", frontendUrl: "https://trockcrm.com",
    });
    expect(email.text).toMatch(/too large/i);
    expect(email.text).toContain("download it");
    expect(email.text).not.toMatch(/still generating/i);
  });
});

describe("handleFieldScorecardEmail", () => {
  it("throws when recipients are unconfigured in prod (retry → dead-letter)", async () => {
    const { query } = makeQuery(null);
    await expect(
      handleFieldScorecardEmail(payload(), null, {
        query, env: { NODE_ENV: "production" } as NodeJS.ProcessEnv, logger: silent,
        sendEmail: vi.fn(), getPdf: vi.fn(),
      }),
    ).rejects.toThrow(/FIELD_SCORECARD_EMAIL_RECIPIENTS/);
  });

  it("skips when the scorecard's email was already sent", async () => {
    const { query } = makeQuery("2026-06-30T18:00:00Z");
    const sendEmail = vi.fn();
    await handleFieldScorecardEmail(payload(), null, { query, env: PROD, logger: silent, sendEmail, getPdf: vi.fn() });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("sends with the PDF attached and stamps email_sent_at", async () => {
    const { query, calls } = makeQuery(null);
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m1" });
    const getPdf = vi.fn().mockResolvedValue(Buffer.from("%PDF-fake"));
    await handleFieldScorecardEmail(payload(), null, { query, env: PROD, logger: silent, sendEmail, getPdf });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const opts = sendEmail.mock.calls[0][3];
    expect(opts.attachments).toHaveLength(1);
    expect(opts.idempotencyKey).toContain("field-scorecard-office_dallas-");
    // stamped email_sent_at via an UPDATE
    expect(calls.some((c) => /UPDATE/i.test(c.sql) && /email_sent_at/.test(c.sql))).toBe(true);
  });

  it("degrades to a no-attachment email when the PDF isn't in R2 yet (getPdf returns null)", async () => {
    const { query } = makeQuery(null);
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m2" });
    const getPdf = vi.fn().mockResolvedValue(null);
    await handleFieldScorecardEmail(payload(), null, { query, env: PROD, logger: silent, sendEmail, getPdf });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][3].attachments).toBeUndefined();
  });

  it("sends without attachment (CRM link) when the PDF exceeds the safe attachment size — never dead-letters", async () => {
    const { query } = makeQuery(null);
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m-big" });
    // 21 MB > the 20 MB backstop.
    const getPdf = vi.fn().mockResolvedValue(Buffer.alloc(21 * 1024 * 1024, 0));
    await handleFieldScorecardEmail(payload(), null, { query, env: PROD, logger: silent, sendEmail, getPdf });
    expect(sendEmail).toHaveBeenCalledTimes(1); // sent (degraded), NOT thrown → no retry/dead-letter
    const [, , html, opts] = sendEmail.mock.calls[0];
    expect(opts.attachments).toBeUndefined();
    // The PDF EXISTS (too big to attach) — copy must point to the CRM, not claim it's "still generating".
    expect(html).toMatch(/too large/i);
    expect(html).not.toMatch(/still generating/i);
    expect(opts.text).toContain(`/deals/${payload().dealId}`); // CRM deep link present
  });

  it("degrades (not retries) when the PDF fetch REJECTS — S3 NoSuchKey throws, not null", async () => {
    const { query } = makeQuery(null);
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m3" });
    const getPdf = vi.fn().mockRejectedValue(new Error("NoSuchKey"));
    await handleFieldScorecardEmail(payload(), null, { query, env: PROD, logger: silent, sendEmail, getPdf });
    expect(sendEmail).toHaveBeenCalledTimes(1); // sent (degraded), NOT thrown → no retry/dead-letter
    expect(sendEmail.mock.calls[0][3].attachments).toBeUndefined();
  });

  it("skips a scorecard that no longer exists", async () => {
    const { query } = makeQuery("notfound");
    const sendEmail = vi.fn();
    await handleFieldScorecardEmail(payload(), null, { query, env: PROD, logger: silent, sendEmail, getPdf: vi.fn() });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("ignores a payload with an unsafe tenant schema", async () => {
    const sendEmail = vi.fn();
    await handleFieldScorecardEmail(payload({ tenantSchema: "public; DROP" }), null, {
      query: vi.fn() as any, env: PROD, logger: silent, sendEmail, getPdf: vi.fn(),
    });
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
