import { describe, expect, it, vi } from "vitest";
import {
  handleRfpOverrideApprovedEmail,
  buildRfpOverrideApprovedEmail,
} from "./rfp-override-approved-email.js";

const TENANT = "office_dallas";
const DEAL = "11111111-1111-1111-1111-111111111111";
const OFFICE = "22222222-2222-2222-2222-222222222222";
const REQUESTER = "33333333-3333-3333-3333-333333333333";
const REQUESTER_EMAIL = "rep@trockgc.com";
const TAKASHI = "takashi@trockgc.com";
const ADAM = "ashaw@trockgc.com";

const BASE_PAYLOAD = {
  tenantSchema: TENANT,
  dealId: DEAL,
  dealNumber: "TR-1001",
  dealName: "jasonn ranches",
  rfpApprovalRequestId: 55,
  requestedByUserId: REQUESTER,
};

const ENV = { NODE_ENV: "test", RFP_REJECTION_EMAIL_RECIPIENTS: `${TAKASHI}, ${ADAM}` } as NodeJS.ProcessEnv;
const ENV_NO_LEADERSHIP = { NODE_ENV: "production" } as NodeJS.ProcessEnv;

function makeQuery(opts: { receiptExists?: boolean; repEmail?: string | null; officeFound?: boolean } = {}) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const query = vi.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    if (sql.includes("INSERT INTO public.rfp_override_approved_email_receipts")) return { rows: [] };
    if (sql.includes("FROM public.rfp_override_approved_email_receipts")) {
      return { rows: opts.receiptExists ? [{ resend_message_id: "msg_old", sent_at: new Date() }] : [] };
    }
    if (sql.includes("FROM public.users")) {
      return { rows: opts.repEmail === undefined ? [{ email: REQUESTER_EMAIL }] : opts.repEmail === null ? [] : [{ email: opts.repEmail }] };
    }
    if (sql.includes("FROM public.offices")) {
      return { rows: opts.officeFound === false ? [] : [{ id: OFFICE }] };
    }
    return { rows: [] };
  });
  return { query: query as any, calls };
}

function makeSend() {
  const sendEmail = vi.fn(
    async (
      _to: string | string[],
      _subject: string,
      _html: string,
      _options: { text: string; idempotencyKey: string }
    ) => ({ success: true as const, messageId: "msg_new" })
  );
  return sendEmail;
}

const silentLogger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("handleRfpOverrideApprovedEmail", () => {
  it("sends the success notice to the requesting rep + both leadership recipients, with a trockcrm.com link", async () => {
    const { query, calls } = makeQuery();
    const sendEmail = makeSend();
    await handleRfpOverrideApprovedEmail(BASE_PAYLOAD, null, { query, sendEmail, env: ENV, logger: silentLogger });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const [to, subject, html, options] = sendEmail.mock.calls[0];
    expect(to).toEqual([REQUESTER_EMAIL, TAKASHI, ADAM]);
    expect(subject).toContain("TR-1001");
    expect(subject).toContain("jasonn ranches");
    expect(html).toContain("jasonn ranches");
    // positive/success copy, leadership credited generically (no reviewer named)
    expect(html.toLowerCase()).toContain("approved");
    expect(html.toLowerCase()).toContain("leadership");
    // single View-Deal CTA; the reviewer-only "Review & Decide" page is NOT offered
    expect(html).toContain(`https://trockcrm.com/deals/${DEAL}?officeId=${OFFICE}`);
    expect(html).not.toContain("Review &amp; Decide");
    expect(html).not.toContain("/rfp-review/");
    expect(html).not.toMatch(/trockconstruction\.com/);
    expect(options.idempotencyKey).toBe(`rfp-override-approved-${TENANT}-${DEAL}-55`);
    expect(calls.some((c) => c.sql.includes("INSERT INTO public.rfp_override_approved_email_receipts"))).toBe(true);
  });

  it("degrades to leadership only (still sends) when the requesting rep has no id", async () => {
    const { query } = makeQuery();
    const sendEmail = makeSend();
    await handleRfpOverrideApprovedEmail({ ...BASE_PAYLOAD, requestedByUserId: null }, null, { query, sendEmail, env: ENV, logger: silentLogger });
    expect(sendEmail.mock.calls[0][0]).toEqual([TAKASHI, ADAM]);
  });

  it("degrades to leadership only when the rep id resolves to no user", async () => {
    const { query } = makeQuery({ repEmail: null });
    const sendEmail = makeSend();
    await handleRfpOverrideApprovedEmail(BASE_PAYLOAD, null, { query, sendEmail, env: ENV, logger: silentLogger });
    expect(sendEmail.mock.calls[0][0]).toEqual([TAKASHI, ADAM]);
  });

  it("sends to the rep ALONE (does NOT throw) when leadership is unconfigured", async () => {
    const { query } = makeQuery();
    const sendEmail = makeSend();
    await handleRfpOverrideApprovedEmail(BASE_PAYLOAD, null, { query, sendEmail, env: ENV_NO_LEADERSHIP, logger: silentLogger });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toEqual([REQUESTER_EMAIL]);
  });

  it("logs and SKIPS (no send, no throw) when NEITHER the rep nor leadership resolves", async () => {
    const { query, calls } = makeQuery({ repEmail: null });
    const sendEmail = makeSend();
    await handleRfpOverrideApprovedEmail({ ...BASE_PAYLOAD, requestedByUserId: null }, null, { query, sendEmail, env: ENV_NO_LEADERSHIP, logger: silentLogger });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(calls.some((c) => c.sql.includes("INSERT INTO public.rfp_override_approved_email_receipts"))).toBe(false);
  });

  it("does not double-email the rep if they also appear in the leadership list (case-insensitive dedupe -> single send)", async () => {
    const { query } = makeQuery({ repEmail: "Rep@trockgc.com" });
    const sendEmail = makeSend();
    const env = { NODE_ENV: "test", RFP_REJECTION_EMAIL_RECIPIENTS: `rep@trockgc.com, ${ADAM}` } as NodeJS.ProcessEnv;
    await handleRfpOverrideApprovedEmail(BASE_PAYLOAD, null, { query, sendEmail, env, logger: silentLogger });
    expect(sendEmail.mock.calls[0][0]).toEqual(["Rep@trockgc.com", ADAM]);
  });

  it("skips (no send) when this RFP cycle already has an approved receipt", async () => {
    const { query } = makeQuery({ receiptExists: true });
    const sendEmail = makeSend();
    await handleRfpOverrideApprovedEmail(BASE_PAYLOAD, null, { query, sendEmail, env: ENV, logger: silentLogger });
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe("buildRfpOverrideApprovedEmail", () => {
  it("builds the success 'override approved' email with a single View-Deal CTA and no review page", () => {
    const email = buildRfpOverrideApprovedEmail({
      dealId: DEAL,
      dealName: "jasonn ranches",
      dealNumber: "TR-1001",
      officeId: OFFICE,
      frontendUrl: "https://trockcrm.com",
    });
    expect(email.subject).toContain("TR-1001");
    expect(email.subject).toContain("jasonn ranches");
    expect(email.dealUrl).toBe(`https://trockcrm.com/deals/${DEAL}?officeId=${OFFICE}`);
    expect(email.html).toContain("View Deal in CRM");
    expect(email.html.toLowerCase()).toContain("approved");
    expect(email.html.toLowerCase()).toContain("leadership");
    expect(email.html).not.toContain("/rfp-review/");
    expect(email.html).not.toContain("Review &amp; Decide");
    expect(email.html).not.toMatch(/trockconstruction\.com/);
    expect(email.text).not.toMatch(/trockconstruction\.com/);
  });

  it("omits the query string when the office is unresolved and handles a missing project number", () => {
    const email = buildRfpOverrideApprovedEmail({
      dealId: DEAL,
      dealName: "jasonn ranches",
      dealNumber: null,
      officeId: null,
      frontendUrl: "https://trockcrm.com",
    });
    expect(email.dealUrl).toBe(`https://trockcrm.com/deals/${DEAL}`);
    expect(email.html).toContain("Pending");
  });
});
