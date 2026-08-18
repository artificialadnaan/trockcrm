import { describe, expect, it, vi } from "vitest";
import {
  handleFieldScorecardEmail,
  type FieldScorecardEmailPayload,
} from "../../src/jobs/field-scorecard-email.js";

const DIGEST = "a".repeat(64);
const PDF_KEY = `office_dallas/deals/DFW-10432/documents/scorecards/card.${DIGEST}.v2.pdf`;
const payload: FieldScorecardEmailPayload = {
  tenantSchema: "office_dallas",
  scorecardId: "11111111-1111-1111-1111-111111111111",
  dealId: "22222222-2222-2222-2222-222222222222",
  dealName: "Maple Street Tower",
  projectNumber: "DFW-10432",
  weekOf: "2026-07-06",
  totalScore: 84,
  ratingLabel: "Meets Standard",
  pdfR2Key: PDF_KEY,
};
const env = {
  NODE_ENV: "production",
  FIELD_SCORECARD_EMAIL_RECIPIENTS: "ops@trock.com",
} as unknown as NodeJS.ProcessEnv;
const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

function queryWithCurrentKey(pdfR2Key: string | null, pdfRenderVersion = 2) {
  return vi.fn(async (query: string) => {
    if (/SELECT/i.test(query)) {
      return {
        rows: [{
          email_sent_at: null,
          pdf_r2_key: pdfR2Key,
          pdf_render_version: pdfRenderVersion,
        }],
      };
    }
    return { rows: [] };
  });
}

/**
 * The same row, with GENERATIONS — and with a distinct pair for the POST-FETCH revalidation, so a change
 * landing during the R2 read can be modelled separately from one visible before it.
 *
 * The generations are canonical microsecond TEXT because that is how the handler now reads them (a raw
 * timestamptz arrives as a millisecond JS Date and the microseconds are gone). Written as explicit literals:
 * no clock available to a test — JS or Postgres-in-wasm — can produce a sub-millisecond difference, so a
 * derived fixture could not express the failure these cover.
 */
function queryWithGenerations(over: {
  rendered: string | null;
  current: string | null;
  postFetchRendered?: string | null;
  postFetchCurrent?: string | null;
  pdfR2Key?: string;
  pdfRenderVersion?: number;
}) {
  const key = over.pdfR2Key ?? `office_dallas/deals/DFW-10432/documents/scorecards/card.${DIGEST}.v4.pdf`;
  let selects = 0;
  const query = vi.fn(async (sql: string) => {
    if (!/SELECT/i.test(sql)) return { rows: [] };
    selects += 1;
    // The first SELECT is the pre-fetch idempotency/artifact read; the second is the post-fetch guard.
    const postFetch = selects > 1;
    return {
      rows: [{
        email_sent_at: null,
        status: "corrective_action_closed",
        pdf_r2_key: key,
        pdf_render_version: over.pdfRenderVersion ?? 4,
        pdf_content_generation: postFetch
          ? (over.postFetchRendered === undefined ? over.rendered : over.postFetchRendered)
          : over.rendered,
        updated_at: postFetch
          ? (over.postFetchCurrent === undefined ? over.current : over.postFetchCurrent)
          : over.current,
      }],
    };
  });
  return { query, key };
}

describe("field scorecard email artifact safety", () => {
  it("uses the row's current artifact key after regeneration, not a stale queued payload key", async () => {
    const currentKey = `office_dallas/deals/DFW-10432/documents/scorecards/card.${"b".repeat(64)}.v3.pdf`;
    const getPdf = vi.fn().mockResolvedValue(Buffer.from("%PDF-current"));
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "mail-1" });

    await handleFieldScorecardEmail(
      { ...payload, pdfR2Key: "legacy.pdf" },
      null,
      { query: queryWithCurrentKey(currentKey, 3) as any, getPdf, sendEmail, env, logger },
    );

    expect(getPdf).toHaveBeenCalledWith(currentKey);
    expect(sendEmail.mock.calls[0][3].attachments).toHaveLength(1);
  });

  it("sends without an attachment when evidence deletion invalidated the row key", async () => {
    const getPdf = vi.fn().mockResolvedValue(Buffer.from("%PDF-stale-with-deleted-evidence"));
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "mail-2" });

    await handleFieldScorecardEmail(
      payload,
      null,
      { query: queryWithCurrentKey(null) as any, getPdf, sendEmail, env, logger },
    );

    expect(getPdf).not.toHaveBeenCalled();
    expect(sendEmail).toHaveBeenCalledOnce();
    expect(sendEmail.mock.calls[0][3].attachments).toBeUndefined();
  });

  it("REGRESSION: does not attach a PDF the card outgrew by less than a millisecond", async () => {
    // `timestamptz` is microseconds, a JS Date is milliseconds. Compared through millisecond values, a
    // render that read the card at .123456 and the change that committed at .123900 are indistinguishable,
    // so "provably stale" proves nothing and the submitted-scorecard email carries the PRE-change document.
    const { query } = queryWithGenerations({
      rendered: "2026-07-27T14:00:00.123456Z",
      current: "2026-07-27T14:00:00.123900Z",
    });
    const getPdf = vi.fn().mockResolvedValue(Buffer.from("%PDF-pre-change"));
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "mail-us-1" });

    await handleFieldScorecardEmail(payload, null, {
      query: query as any, getPdf, sendEmail, env, logger,
    });

    expect(getPdf).not.toHaveBeenCalled();
    expect(sendEmail.mock.calls[0][3].attachments).toBeUndefined();
  });

  it("REGRESSION: the POST-FETCH guard sees a sub-millisecond change during the R2 read", async () => {
    // Everything before the fetch described the row as it was; the fetch is the slowest step in the handler.
    // A revalidation at a coarser resolution than the change it is looking for revalidates nothing.
    const { query } = queryWithGenerations({
      rendered: "2026-07-27T14:00:00.123456Z",
      current: "2026-07-27T14:00:00.123456Z",
      postFetchCurrent: "2026-07-27T14:00:00.123900Z",
    });
    const getPdf = vi.fn().mockResolvedValue(Buffer.from("%PDF-fetched"));
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "mail-us-2" });

    await handleFieldScorecardEmail(payload, null, {
      query: query as any, getPdf, sendEmail, env, logger,
    });

    expect(getPdf).toHaveBeenCalledOnce();
    expect(sendEmail.mock.calls[0][3].attachments).toBeUndefined();
  });

  it("attaches when the generations match to the microsecond", async () => {
    // The other side of the coin: full-precision equality must still read as current, or no scorecard email
    // would ever carry its PDF again.
    const { query, key } = queryWithGenerations({
      rendered: "2026-07-27T14:00:00.123456Z",
      current: "2026-07-27T14:00:00.123456Z",
    });
    const getPdf = vi.fn().mockResolvedValue(Buffer.from("%PDF-current"));
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "mail-us-3" });

    await handleFieldScorecardEmail(payload, null, {
      query: query as any, getPdf, sendEmail, env, logger,
    });

    expect(getPdf).toHaveBeenCalledWith(key);
    expect(sendEmail.mock.calls[0][3].attachments).toHaveLength(1);
  });

  it.each([
    {
      name: "a legacy v1 artifact",
      key: `office_dallas/deals/DFW-10432/documents/scorecards/card.${DIGEST}.v1.pdf`,
      version: 1,
    },
    {
      name: "a late legacy writer's key on a v2 row",
      key: "office_dallas/deals/DFW-10432/documents/scorecards/card.pdf",
      version: 2,
    },
    {
      name: "the old non-content-addressed v2 key",
      key: "office_dallas/deals/DFW-10432/documents/scorecards/card.v2.pdf",
      version: 2,
    },
  ])("sends the CRM-link fallback instead of attaching $name", async ({ key, version }) => {
    const getPdf = vi.fn().mockResolvedValue(Buffer.from("%PDF-stale-without-current-evidence"));
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: `mail-stale-${version}` });

    await handleFieldScorecardEmail(
      payload,
      null,
      { query: queryWithCurrentKey(key, version) as any, getPdf, sendEmail, env, logger },
    );

    expect(getPdf).not.toHaveBeenCalled();
    expect(sendEmail).toHaveBeenCalledOnce();
    expect(sendEmail.mock.calls[0][3].attachments).toBeUndefined();
  });
});

// The completed-scorecard email is deduped at the provider by a per-scorecard idempotency key. That key has to
// follow the DELIVERY, not just the card: a pending or dead job is NOT proof nothing was sent (the provider can
// accept a send and the process die before email_sent_at is stamped, returning the job to pending). If the
// server then RE-ADDRESSES that job — an edit corrected which field responder the card picked — replaying the
// base key with a changed payload is answered `invalid_idempotent_request`, which sendSystemEmailWithMetadata
// deliberately treats as already-delivered. The corrected send would be silently dropped and the card stamped
// sent. The server mints a deliveryNonce on every re-address to rotate the key.
describe("field scorecard email idempotency key", () => {
  const BASE = "field-scorecard-office_dallas-11111111-1111-1111-1111-111111111111";

  async function keyFor(extra: Partial<FieldScorecardEmailPayload>): Promise<string> {
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "m" });
    await handleFieldScorecardEmail(
      { ...payload, ...extra },
      null,
      {
        query: queryWithCurrentKey(null) as never,
        getPdf: vi.fn().mockResolvedValue(null),
        sendEmail,
        env,
        logger,
      },
    );
    return sendEmail.mock.calls[0][3].idempotencyKey as string;
  }

  it("is byte-identical to the pre-existing key when the job was never re-addressed", async () => {
    expect(await keyFor({})).toBe(BASE);
  });

  it("rotates once the server stamps a deliveryNonce", async () => {
    expect(await keyFor({ deliveryNonce: "nonce-abc" })).toBe(`${BASE}-delivery-nonce-abc`);
  });

  it("gives a different key per re-address, so a second correction also delivers", async () => {
    expect(await keyFor({ deliveryNonce: "nonce-1" })).not.toBe(await keyFor({ deliveryNonce: "nonce-2" }));
  });
});
