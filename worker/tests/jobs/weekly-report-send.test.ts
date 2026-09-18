import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WEEKLY_REPORT_SEND_REQUEST_KEYS,
  weeklyReportSendErrorIsProvableRejection,
} from "@trock-crm/shared/lib/weeklyReportEmail";
import {
  buildWeeklyReportClientEmail,
  handleWeeklyReportSend,
  weeklyReportAttachmentFilename,
} from "../../src/jobs/weekly-report-send.js";

// The delivery half of the weekly report.
//
// Everything here asserts CONTENT and PERSISTED STATE, not call counts: "the provider was called once"
// says nothing about whether the client got a working link, and "an error was logged" says nothing about
// whether a PM will ever see it. The two properties this suite exists for are that a client is never sent
// two copies of the same report, and that a failure is written where the dashboard reads it.

const SCHEMA = "office_dallas";
const REPORT = "6b1f6f2e-9d1a-4e4a-9c2b-1f4d8a0c5e31";
const DELIVERY_KEY = "9f2a1c44-3f6b-4a2f-9d55-6e7c8b9a0d12";
const SHARE_URL = "https://reports.example.com/wr/AbCdEfGh";

const SEND_REQUEST = {
  recipients: ["jay@example.com", "melissa@example.com"],
  subject: "4123 Cedar Springs — Weekly Progress Report, Week of 8/13/26",
  greetingName: "Jay Stauble",
  contextParagraph: "Framing is complete on levels 3 and 4.",
  shareUrl: SHARE_URL,
  sender: { name: "Adam Sherwood", email: "adam@trockconstruction.com", phone: "(214) 555-0142" },
  attachPdf: true,
  isCorrection: false,
  requestedBy: "00000000-0000-4000-8000-000000000001",
  requestedAt: "2026-08-13T21:00:00.000Z",
  requestVersion: 1,
};

const SILENT_LOGGER = { log: () => {}, warn: () => {}, error: () => {} };

// THESE TESTS DESCRIBE AN AUTHORISED PRODUCTION WORKER. The job refuses to email a customer from any
// deployment that has not explicitly opted in, so the flag is stubbed here and unset by the cases that
// assert the refusal — see "only an explicitly authorised deployment may email a real client" below.
//
// NODE_ENV is stubbed to `production` too, and NOT because the guard reads it: it does not, deliberately.
// `Dockerfile.worker` bakes `ENV NODE_ENV=production` into the runtime stage, so that value is a property
// of the IMAGE and is identical on the production worker, on a staging worker running the same image, and
// on `node worker/dist/index.js` locally. Keeping it stubbed here is what lets the refusal cases prove the
// guard no longer depends on it.
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("WEEKLY_REPORT_CLIENT_EMAIL_ENABLED", "true");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function payload(overrides: Record<string, unknown> = {}) {
  return {
    reportId: REPORT,
    officeSlug: "dallas",
    tenantSchema: SCHEMA,
    deliveryKey: DELIVERY_KEY,
    ...overrides,
  };
}

/**
 * A `query` that answers the handler's one SELECT from a row object and RECORDS every UPDATE.
 *
 * The updates are the product here — `send_attempts`, `send_error` and `send_delivered_at` are what the
 * CRM chip reads — so they are captured and asserted rather than swallowed by a blanket stub.
 */
function fakeQuery(row: Record<string, unknown> | null) {
  const updates: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (/^\s*SELECT/i.test(sql)) return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    updates.push({ sql, params });
    return { rows: [], rowCount: 1 };
  });
  return { query: query as any, updates };
}

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    status: "sent",
    week_of: "2026-08-13",
    version: 1,
    // Read from the report's frozen snapshot, which `sent` guarantees exists.
    property_display_name: "4123 Cedar Springs",
    send_request: SEND_REQUEST,
    send_delivery_key: DELIVERY_KEY,
    send_delivered_at: null,
    send_attempts: 0,
    ...overrides,
  };
}

function okSend() {
  return vi.fn(async () => ({ success: true, messageId: "msg_1" }));
}

describe("the stored request is the API's, not this file's idea of it", () => {
  it("uses a fixture carrying EXACTLY the keys the API writes", async () => {
    // Without this the suite below is circular: every assertion about what the worker sends is read out
    // of SEND_REQUEST, which is hand-written here — so a field the API stopped writing (the PM's edited
    // subject, the whole signature block, the attach-PDF toggle) would break nothing in either package.
    // The key list lives in shared and the API asserts its own row against the same one.
    expect(Object.keys(SEND_REQUEST).sort()).toEqual([...WEEKLY_REPORT_SEND_REQUEST_KEYS].sort());
  });
});

describe("delivering the report", () => {
  it("sends the stored message, with the link and the PM's details, and stamps delivery", async () => {
    const { query, updates } = fakeQuery(baseRow());
    const sendEmail = okSend();

    await handleWeeklyReportSend(payload(), null, {
      query,
      sendEmail,
      resolvePdfKey: async () => "office_dallas/deals/DFW-10432/report.pdf",
      getPdf: async () => Buffer.from("%PDF-1.7 pretend"),
      logger: SILENT_LOGGER,
    });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const [to, subject, html, options] = sendEmail.mock.calls[0]!;
    expect(to).toEqual(["jay@example.com", "melissa@example.com"]);
    expect(subject).toBe(SEND_REQUEST.subject);
    // The link must be in BOTH parts. A client reading the plain-text alternative — which is what many
    // corporate mail clients render — would otherwise get a report with no way to open it.
    expect(options.text).toContain(SHARE_URL);
    expect(html).toContain(SHARE_URL);
    expect(options.text).toContain("Hello Jay,");
    expect(options.text).toContain("(214) 555-0142");
    expect(options.attachments?.[0]?.content.toString()).toContain("%PDF");
    // Named from the SNAPSHOT and the week, so what lands in the client's downloads folder is the
    // property and the week rather than an internal uuid.
    expect(options.attachments?.[0]?.filename).toBe("4123 Cedar Springs - Weekly Report 2026-08-13.pdf");

    const delivered = updates.find((update) => update.sql.includes("send_delivered_at"));
    expect(delivered).toBeDefined();
    // delivered = true, error = null. Asserted on the bound values rather than on "an update happened".
    expect(delivered!.params).toEqual([REPORT, null, true]);
    // Conditioned on the row still being an undelivered `sent`, so a stamp from a slow attempt cannot
    // land on a report a correction or a concurrent success has already moved on.
    expect(delivered!.sql).toContain("send_delivered_at IS NULL");
    expect(delivered!.sql).toContain("status = 'sent'");
  });

  it("keys the provider idempotency on the DELIVERY KEY, so a retry cannot double-send", async () => {
    // This is the guard that covers the window `send_delivered_at` cannot: provider accepted, process
    // died before the stamp, job back to pending. Replaying the same key is answered "already delivered".
    const { query } = fakeQuery(baseRow());
    const sendEmail = okSend();
    await handleWeeklyReportSend(payload(), null, {
      query,
      sendEmail,
      resolvePdfKey: async () => null,
      logger: SILENT_LOGGER,
    });
    expect(sendEmail.mock.calls[0]![3].idempotencyKey).toBe(
      `weekly-report-${SCHEMA}-${REPORT}-${DELIVERY_KEY}`,
    );
  });

  it("says plainly that a correction replaces the copy the client already has", async () => {
    const { query } = fakeQuery(
      baseRow({ version: 2, send_request: { ...SEND_REQUEST, isCorrection: true, contextParagraph: "" } }),
    );
    const sendEmail = okSend();
    await handleWeeklyReportSend(payload(), null, {
      query,
      sendEmail,
      resolvePdfKey: async () => null,
      logger: SILENT_LOGGER,
    });
    expect(sendEmail.mock.calls[0]![3].text).toMatch(/revised version/i);
    expect(sendEmail.mock.calls[0]![3].text).toMatch(/replaces the previous copy/i);
  });
});

describe("never sending twice", () => {
  it("does nothing for a report already delivered", async () => {
    const { query, updates } = fakeQuery(baseRow({ send_delivered_at: "2026-08-13T21:05:00.000Z" }));
    const sendEmail = okSend();
    await handleWeeklyReportSend(payload(), null, { query, sendEmail, logger: SILENT_LOGGER });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it("drops a job left over from a SUPERSEDED send request", async () => {
    // The row now describes a different request — different recipients, or a link that has been
    // replaced. Running the stale job would deliver a message the report no longer stands behind.
    const { query, updates } = fakeQuery(baseRow({ send_delivery_key: "a-different-key" }));
    const sendEmail = okSend();
    await handleWeeklyReportSend(payload(), null, { query, sendEmail, logger: SILENT_LOGGER });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it("does nothing for a report that is not `sent`", async () => {
    const { query } = fakeQuery(baseRow({ status: "approved" }));
    const sendEmail = okSend();
    await handleWeeklyReportSend(payload(), null, { query, sendEmail, logger: SILENT_LOGGER });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("does nothing for a report that no longer exists", async () => {
    const { query } = fakeQuery(null);
    const sendEmail = okSend();
    await handleWeeklyReportSend(payload(), null, { query, sendEmail, logger: SILENT_LOGGER });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("drops a payload whose office and tenant schema disagree", async () => {
    // The two are INDEPENDENT fields addressing different things: the row is read out of `tenantSchema`
    // while the PDF is rendered for `officeSlug`. Divergence attaches another office's report to this
    // client's email. The enqueue writes both from one value, so they can only disagree through a bug —
    // which is precisely when a shape-only check is not enough.
    const { query, updates } = fakeQuery(baseRow());
    const sendEmail = okSend();
    const resolvePdfKey = vi.fn(async () => "some/key.pdf");
    await expect(
      handleWeeklyReportSend(payload({ officeSlug: "houston" }), null, {
        query,
        sendEmail,
        resolvePdfKey,
        logger: SILENT_LOGGER,
      }),
    ).resolves.toBeUndefined();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(resolvePdfKey).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it("refuses a malformed payload without burning retries on it", async () => {
    const sendEmail = okSend();
    const { query } = fakeQuery(baseRow());
    for (const bad of [
      payload({ tenantSchema: "public; DROP TABLE users" }),
      payload({ reportId: "" }),
      payload({ deliveryKey: null }),
      payload({ officeSlug: undefined }),
    ]) {
      // Returns rather than throws: waiting does not make a malformed payload well-formed, and throwing
      // would spend three attempts discovering that.
      await expect(handleWeeklyReportSend(bad as any, null, { query, sendEmail, logger: SILENT_LOGGER }))
        .resolves.toBeUndefined();
    }
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe("making failure visible", () => {
  it("PERSISTS the error and the attempt, then rethrows so the queue retries", async () => {
    // The whole difference from the fire-and-forget scorecard path. If this write is skipped, a client
    // never receives their report and no surface in the product says so.
    const { query, updates } = fakeQuery(baseRow());
    const sendEmail = vi.fn(async () => {
      throw new Error("Resend timed out");
    });

    await expect(
      handleWeeklyReportSend(payload(), null, {
        query,
        sendEmail,
        resolvePdfKey: async () => null,
        logger: SILENT_LOGGER,
      }),
    ).rejects.toThrow(/Resend timed out/);

    const attempt = updates.find((update) => update.sql.includes("send_attempts = send_attempts + 1"));
    expect(attempt).toBeDefined();
    expect(attempt!.params).toEqual([REPORT, "Resend timed out", false]);
    expect(attempt!.sql).toContain("send_last_attempt_at = NOW()");
  });

  it("treats an unsuccessful provider result as a failure, not a delivery", async () => {
    // `sendSystemEmailWithMetadata` returns `{ success: false }` rather than throwing for a Resend error
    // and for an unconfigured API key in production. Reading only the throw would stamp those delivered.
    const { query, updates } = fakeQuery(baseRow());
    // The FULL failure shape, not `{success, messageId}`: this file is outside the typecheck program, so a
    // stub missing `outcome` and `reason` compiles happily and quietly tests a result the library cannot
    // return. Here it is Resend's rate limit — a real 429.
    const sendEmail = vi.fn(async () => ({
      success: false,
      messageId: null,
      outcome: "rejected" as const,
      reason: "rate_limit_exceeded 429: Too many requests. Please limit the number of requests per second.",
    }));

    await expect(
      handleWeeklyReportSend(payload(), null, {
        query,
        sendEmail,
        resolvePdfKey: async () => null,
        logger: SILENT_LOGGER,
      }),
    ).rejects.toThrow();

    const attempt = updates.find((update) => update.sql.includes("send_attempts = send_attempts + 1"));
    expect(attempt!.params[2]).toBe(false);
    expect(updates.every((update) => update.params[2] !== true)).toBe(true);
  });

  it("records a stored request with no usable recipients rather than failing silently", async () => {
    const { query, updates } = fakeQuery(
      baseRow({ send_request: { ...SEND_REQUEST, recipients: ["not-an-address"] } }),
    );
    const sendEmail = okSend();
    await expect(
      handleWeeklyReportSend(payload(), null, { query, sendEmail, logger: SILENT_LOGGER }),
    ).rejects.toThrow(/no valid recipients/i);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(updates.find((u) => u.sql.includes("send_attempts"))!.params[1]).toMatch(/no valid recipients/i);
  });

  it("records a `sent` report carrying no send request at all", async () => {
    const { query, updates } = fakeQuery(baseRow({ send_request: null }));
    const sendEmail = okSend();
    await expect(
      handleWeeklyReportSend(payload(), null, { query, sendEmail, logger: SILENT_LOGGER }),
    ).rejects.toThrow(/no stored send request/i);
    expect(updates.find((u) => u.sql.includes("send_attempts"))!.params[1]).toMatch(/no stored send request/i);
  });

  // NOTE: the truncation of a runaway provider message is asserted in "a send failure a PM can actually
  // act on" below, from a RESULT rather than a throw. The version that used to live here injected a stub
  // that THREW a 5000-character error, and `sendSystemEmailWithMetadata` never throws for a provider or
  // network failure — resend@6.10.0 wraps its entire fetch in try/catch and returns
  // `{error:{name:"application_error", statusCode:null}}` (verified in node_modules/resend/dist/index.cjs).
  // So it drove the slice down a path no deployed input can reach, and would have stayed green through
  // any change to the path that is actually taken.
});

describe("a delivery that succeeded is never written down as a failure", () => {
  it("does NOT record an error when the provider accepted but the stamp could not be written", async () => {
    // The bug: the delivered stamp used to sit INSIDE the same try as the send, so a database that went
    // away between Resend accepting the message and the row being updated was recorded as a send failure
    // — for a send that succeeded. The catch could not tell the two apart, so the board raised a chip
    // that was simply false and offered a Retry for an email the client already had.
    const updates: Array<{ sql: string; params: unknown[] }> = [];
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (/^\s*SELECT/i.test(sql)) return { rows: [baseRow()], rowCount: 1 };
      updates.push({ sql, params });
      throw new Error("timeout exceeded when trying to connect");
    }) as any;
    const sendEmail = okSend();

    await expect(
      handleWeeklyReportSend(payload(), null, {
        query,
        sendEmail,
        resolvePdfKey: async () => null,
        logger: SILENT_LOGGER,
      }),
    ).rejects.toThrow(/delivered but recording the delivery failed/i);

    // The client HAS the report — exactly once.
    expect(sendEmail).toHaveBeenCalledTimes(1);
    // Exactly one write was attempted, and it was the DELIVERED one. Nothing tried to record a failure.
    expect(updates).toHaveLength(1);
    expect(updates[0]!.params).toEqual([REPORT, null, true]);
    expect(updates.some((update) => update.params[1] !== null)).toBe(false);
  });

  it("still throws, so the queue replays the same idempotency key rather than giving up", async () => {
    // Rethrowing is the right answer: the replay carries the same key, the provider answers "already
    // delivered", and the stamp is attempted again. Swallowing it would leave the row permanently
    // undelivered with nothing to retry it.
    const { query } = fakeQuery(baseRow());
    const failing = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (/^\s*SELECT/i.test(sql)) return query(sql, params);
      throw new Error("connection terminated");
    }) as any;
    await expect(
      handleWeeklyReportSend(payload(), null, {
        query: failing,
        sendEmail: okSend(),
        resolvePdfKey: async () => null,
        logger: SILENT_LOGGER,
      }),
    ).rejects.toThrow();
  });
});

describe("a send failure a PM can actually act on", () => {
  // `send_error` is the ONLY diagnostic this feature ships: weekly-reports-page.tsx renders it as the
  // tooltip on the "Send failed" chip. It used to be the SAME 42-character constant for every reachable
  // production failure, because the handler read `result.success` and threw away `result.outcome`. A
  // director whose send died on a misspelled client domain (fix: issue a correction with the right
  // address) saw byte-identical text to one who was rate-limited (fix: wait) and to one whose worker had
  // no RESEND_API_KEY (fix: an env var).
  //
  // The stubs below return what `sendSystemEmailWithMetadata` ACTUALLY returns for these cases —
  // `{success:false, messageId:null, outcome, reason}` — and never throw, because it never throws for a
  // provider or network failure: resend@6.10.0 wraps its whole fetch in try/catch and hands back an
  // ordinary error result. worker/tests/lib/system-email.test.ts pins both halves of that shape against
  // the real dependency.
  const REJECTED_REASON =
    "validation_error 422: Invalid `to` field. The following addresses are invalid: jay@exmaple.cmo";
  const UNKNOWN_REASON =
    "application_error: Unable to fetch data. The request could not be resolved.";

  function failingSend(outcome: "rejected" | "unknown", reason: string) {
    return vi.fn(async () => ({ success: false, messageId: null, outcome, reason }));
  }

  async function sendErrorFor(sendEmail: ReturnType<typeof failingSend>): Promise<string> {
    const { query, updates } = fakeQuery(baseRow());
    await expect(
      handleWeeklyReportSend(payload(), null, {
        query,
        sendEmail,
        resolvePdfKey: async () => null,
        logger: SILENT_LOGGER,
      }),
    ).rejects.toThrow();
    return String(updates.find((u) => u.sql.includes("send_attempts"))!.params[1]);
  }

  it("writes the provider's own words, so a typo'd client address does not read like a rate limit", async () => {
    const written = await sendErrorFor(failingSend("rejected", REJECTED_REASON));
    expect(written).toContain("validation_error");
    expect(written).toContain("jay@exmaple.cmo");
    expect(written).not.toBe("Email provider returned unsuccessful result");
  });

  it("says whether the message was PROVABLY not sent, or merely unconfirmed", async () => {
    // The distinction the API's retry route needs: `rejected` created nothing, so a replay cannot
    // duplicate it at any age; `unknown` may already be in the client's inbox. Discarding `outcome`
    // collapsed them into one string, which is why a PM retrying a provable rejection past the provider
    // dedup window is warned about a second copy that cannot exist.
    const rejected = await sendErrorFor(failingSend("rejected", REJECTED_REASON));
    const unknown = await sendErrorFor(failingSend("unknown", UNKNOWN_REASON));
    expect(rejected.startsWith("rejected")).toBe(true);
    expect(unknown.startsWith("unknown")).toBe(true);
    expect(rejected).not.toBe(unknown);
  });

  it("still records something usable when the provider gave no reason at all", async () => {
    const written = await sendErrorFor(failingSend("unknown", ""));
    expect(written.startsWith("unknown")).toBe(true);
    expect(written.length).toBeGreaterThan(0);
  });

  it("bounds a runaway provider message, from an input the provider can really produce", async () => {
    // Resend's validation error names every address it refused. A weekly report addressed to a long
    // distribution list produces a message thousands of characters long, and `send_error` is read into a
    // tooltip. This is what the old truncation test claimed to cover with a stub that THREW a 5000-character
    // error — a shape no deployed input can produce, so the slice was never exercised by anything real.
    const refused = Array.from(
      { length: 120 },
      (_, index) => `contact${index}@a-very-long-client-domain-example.com`,
    ).join(", ");
    const reason = `validation_error 422: Invalid \`to\` field. The following addresses are invalid: ${refused}`;
    expect(reason.length).toBeGreaterThan(500);
    expect(await sendErrorFor(failingSend("rejected", reason))).toHaveLength(500);
  });
});

describe("a correction issued while the PDF was still rendering", () => {
  const NEWER_REPORT = "1c0a7d51-0f2e-4b76-8f1a-2d9c3e5b7a04";

  /** A `query` whose SELECT answer can change mid-handler, which is the whole point of these cases. */
  function mutableQuery(rowFor: () => Record<string, unknown>) {
    const updates: Array<{ sql: string; params: unknown[] }> = [];
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (/^\s*SELECT/i.test(sql)) return { rows: [rowFor()], rowCount: 1 };
      updates.push({ sql, params });
      return { rows: [], rowCount: 1 };
    });
    return { query: query as any, updates, calls: query };
  }

  it("does not deliver a version that was superseded while its PDF rendered", async () => {
    // CHECK-THEN-ACT across the longest thing this job does. `superseded_by_id` is read once at the top
    // and nothing re-reads it, while resolving the PDF downloads and transcodes every photo and uploads
    // to R2 — seconds during which a PM can issue a correction. That stamps `superseded_by_id` on THIS
    // row and queues v2, and this job then sends anyway.
    //
    // The client receives BOTH and neither admits the other exists: v1 carries a frozen
    // `isCorrection: false`, and v2's own `isCorrection` was computed from `send_delivered_at IS NOT NULL`
    // on v1 — still NULL at the moment v2 was committed — so v2 says it is not a correction either. Two
    // "here is this week's report" emails, two links, one of which renders a superseded banner.
    let superseded = false;
    const { query, updates } = mutableQuery(() =>
      baseRow(superseded ? { superseded_by_id: NEWER_REPORT } : {}),
    );
    const sendEmail = okSend();

    await expect(
      handleWeeklyReportSend(payload(), null, {
        query,
        sendEmail,
        // The correction lands while this render is in flight.
        resolvePdfKey: async () => {
          superseded = true;
          return null;
        },
        logger: SILENT_LOGGER,
      }),
    ).resolves.toBeUndefined();

    expect(sendEmail).not.toHaveBeenCalled();
    // Skipped, not recorded as a failure — the same reasoning the top-of-handler check gives. No amount
    // of retrying makes a superseded report the right thing to send, and a "Send failed" chip on v1 would
    // send a PM chasing a delivery that must never happen.
    expect(updates).toHaveLength(0);
  });

  it("does not deliver a report another worker delivered while its PDF rendered", async () => {
    // The other duplicate in the same window: a retry running concurrently with the original.
    let delivered = false;
    const { query, updates } = mutableQuery(() =>
      baseRow(delivered ? { send_delivered_at: "2026-08-13T21:05:00.000Z" } : {}),
    );
    const sendEmail = okSend();

    await handleWeeklyReportSend(payload(), null, {
      query,
      sendEmail,
      resolvePdfKey: async () => {
        delivered = true;
        return null;
      },
      logger: SILENT_LOGGER,
    });

    expect(sendEmail).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it("does not deliver under a delivery key the row stopped describing mid-render", async () => {
    let rekeyed = false;
    const { query } = mutableQuery(() =>
      baseRow(rekeyed ? { send_delivery_key: "a-newer-request-key" } : {}),
    );
    const sendEmail = okSend();

    await handleWeeklyReportSend(payload(), null, {
      query,
      sendEmail,
      resolvePdfKey: async () => {
        rekeyed = true;
        return null;
      },
      logger: SILENT_LOGGER,
    });

    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("CONTROL: still delivers when nothing changed while the PDF rendered", async () => {
    const { query, updates } = fakeQuery(baseRow());
    const sendEmail = okSend();

    await handleWeeklyReportSend(payload(), null, {
      query,
      sendEmail,
      resolvePdfKey: async () => null,
      logger: SILENT_LOGGER,
    });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    // The re-read RAN and let it through — two SELECTs, one before the render and one after. Without this
    // the three guards above would also pass on a handler that simply stopped sending.
    expect(query.mock.calls.filter(([sql]: [string]) => /^\s*SELECT/i.test(String(sql)))).toHaveLength(2);
    expect(updates.find((u) => u.sql.includes("send_delivered_at"))!.params[2]).toBe(true);
  });
});

describe("not from a laptop", () => {
  it("refuses to email a real client from an unauthorised worker with no override", async () => {
    // EMAIL_OVERRIDE_RECIPIENT was the only thing standing between a staging or local worker holding a
    // copied RESEND_API_KEY and a real client's inbox, and it ships EMPTY in .env.example. Every other
    // system email in this codebase goes to colleagues; this one goes to a customer contact table.
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("WEEKLY_REPORT_CLIENT_EMAIL_ENABLED", "");
    const { query, updates } = fakeQuery(baseRow());
    const sendEmail = okSend();

    await expect(
      handleWeeklyReportSend(payload(), null, {
        query,
        sendEmail,
        resolvePdfKey: async () => null,
        logger: SILENT_LOGGER,
      }),
    ).rejects.toThrow(/not authorised to email real clients/i);

    expect(sendEmail).not.toHaveBeenCalled();
    // Refused loudly, not silently: the row says exactly what happened.
    const recorded = String(updates.find((u) => u.sql.includes("send_attempts"))!.params[1]);
    expect(recorded).toMatch(/not authorised to email real clients/i);
    // AND IT IS RECORDED AS A PROVABLE REJECTION. The guard fires before the provider is called, so this
    // is the most definite non-send there is — and it used to be stored with no outcome prefix, which the
    // retry dialog reads as ambiguous. A PM retrying would have been told the client may already have the
    // report, for a send that never left the building. On a worker missing the env var that is EVERY
    // send, so the false warning would be on every row rather than an edge case.
    expect(weeklyReportSendErrorIsProvableRejection(recorded)).toBe(true);
  });

  it("stands aside when an override redirects the mail somewhere internal", async () => {
    // The override is not a weaker opt-in — it redirects EVERY recipient to one internal mailbox before
    // the provider is called, so there is no client left to protect.
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("WEEKLY_REPORT_CLIENT_EMAIL_ENABLED", "");
    vi.stubEnv("EMAIL_OVERRIDE_RECIPIENT", "dev@trockconstruction.com");
    const { query } = fakeQuery(baseRow());
    const sendEmail = okSend();
    await handleWeeklyReportSend(payload(), null, {
      query,
      sendEmail,
      resolvePdfKey: async () => null,
      logger: SILENT_LOGGER,
    });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});

describe("only an explicitly authorised deployment may email a real client", () => {
  async function attempt() {
    const { query, updates } = fakeQuery(baseRow());
    const sendEmail = okSend();
    const run = handleWeeklyReportSend(payload(), null, {
      query,
      sendEmail,
      resolvePdfKey: async () => null,
      logger: SILENT_LOGGER,
    });
    return { run, sendEmail, updates };
  }

  it("refuses even under NODE_ENV=production, because the deployed image hardcodes exactly that", async () => {
    // `Dockerfile.worker` sets `ENV NODE_ENV=production` in its RUNTIME stage, so the value is baked into
    // the ARTIFACT rather than supplied by the deployment. It reads `production` for the production
    // worker, for a staging worker running the identical image against a restored production dump, and
    // for `node worker/dist/index.js` on a laptop. A constant cannot say WHICH deployment is running, so
    // the guard it keyed on passed unconditionally in the one case its own docblock named as the threat:
    // "a staging or laptop worker with a copied RESEND_API_KEY".
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("WEEKLY_REPORT_CLIENT_EMAIL_ENABLED", "");
    vi.stubEnv("EMAIL_OVERRIDE_RECIPIENT", "");
    const { run, sendEmail, updates } = await attempt();

    await expect(run).rejects.toThrow(/not authorised to email real clients/i);
    expect(sendEmail).not.toHaveBeenCalled();
    // Refused loudly, not silently: the row names the variable an operator has to set.
    expect(String(updates.find((u) => u.sql.includes("send_attempts"))!.params[1])).toContain(
      "WEEKLY_REPORT_CLIENT_EMAIL_ENABLED",
    );
  });

  it("treats anything short of an explicit opt-in as no opt-in", async () => {
    // Fail-closed in every direction: unset, blank, and a value that plainly says no all refuse. A flag
    // whose absence permits the send is not a control.
    for (const value of ["", "  ", "false", "0", "no", "production"]) {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("EMAIL_OVERRIDE_RECIPIENT", "");
      vi.stubEnv("WEEKLY_REPORT_CLIENT_EMAIL_ENABLED", value);
      const { run, sendEmail } = await attempt();
      await expect(run).rejects.toThrow(/not authorised to email real clients/i);
      expect(sendEmail).not.toHaveBeenCalled();
    }
  });

  it("CONTROL: delivers when the deployment says, in so many words, that it may", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EMAIL_OVERRIDE_RECIPIENT", "");
    vi.stubEnv("WEEKLY_REPORT_CLIENT_EMAIL_ENABLED", "TRUE");
    const { run, sendEmail, updates } = await attempt();

    await expect(run).resolves.toBeUndefined();
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(updates.find((u) => u.sql.includes("send_delivered_at"))!.params[2]).toBe(true);
  });
});

describe("the PDF attachment is a convenience, not a precondition", () => {
  it("still sends when the PDF cannot be produced", async () => {
    // The link in the body is the primary artifact and the CRM regenerates the PDF on demand. Refusing
    // to send would cost the client their report over an attachment.
    const { query, updates } = fakeQuery(baseRow());
    const sendEmail = okSend();
    await handleWeeklyReportSend(payload(), null, {
      query,
      sendEmail,
      resolvePdfKey: async () => {
        throw new Error("render failed");
      },
      logger: SILENT_LOGGER,
    });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0]![3].attachments).toBeUndefined();
    expect(updates.find((u) => u.sql.includes("send_delivered_at"))!.params[2]).toBe(true);
  });

  it("still sends when the object is missing from storage", async () => {
    const { query } = fakeQuery(baseRow());
    const sendEmail = okSend();
    await handleWeeklyReportSend(payload(), null, {
      query,
      sendEmail,
      resolvePdfKey: async () => "some/key.pdf",
      getPdf: async () => null,
      logger: SILENT_LOGGER,
    });
    expect(sendEmail.mock.calls[0]![3].attachments).toBeUndefined();
  });

  it("drops an oversized PDF rather than handing the provider a payload it will reject", async () => {
    const { query } = fakeQuery(baseRow());
    const sendEmail = okSend();
    await handleWeeklyReportSend(payload(), null, {
      query,
      sendEmail,
      resolvePdfKey: async () => "some/key.pdf",
      getPdf: async () => Buffer.alloc(21 * 1024 * 1024),
      logger: SILENT_LOGGER,
    });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0]![3].attachments).toBeUndefined();
  });

  it("never renders a PDF when the PM turned the attachment off", async () => {
    // Rendering downloads and transcodes every photo. Doing it for an email that will not carry it is
    // minutes of CPU per send for nothing.
    const { query } = fakeQuery(baseRow({ send_request: { ...SEND_REQUEST, attachPdf: false } }));
    const sendEmail = okSend();
    const resolvePdfKey = vi.fn(async () => "some/key.pdf");
    await handleWeeklyReportSend(payload(), null, {
      query,
      sendEmail,
      resolvePdfKey,
      logger: SILENT_LOGGER,
    });
    expect(resolvePdfKey).not.toHaveBeenCalled();
    expect(sendEmail.mock.calls[0]![3].attachments).toBeUndefined();
  });
});

describe("the message itself", () => {
  it("puts the link in the HTML exactly once as a button, with its URL visible beneath", async () => {
    const email = buildWeeklyReportClientEmail({
      subject: "S",
      greetingName: "Jay",
      contextParagraph: "Framing is done.",
      shareUrl: SHARE_URL,
      sender: { name: "Adam Sherwood", email: "adam@example.com", phone: "555" },
      isCorrection: false,
    });
    // The sentence is not repeated as body text — the button and the printed URL below it carry the link.
    expect(email.html).not.toContain("Here's the link to your weekly report");
    expect(email.html).toContain("View Weekly Report");
    expect(email.text).toContain("Here's the link to your weekly report: " + SHARE_URL);
    // Outlook needs the VML fallback or the button renders as nothing at all.
    expect(email.html).toContain("v:roundrect");
  });

  it("puts EVERY paragraph in the HTML, not only in the plain-text part", async () => {
    // The assertion this file was missing entirely. Every positive body assertion elsewhere reads
    // `options.text`, and the one test that proved a paragraph reaches the HTML passed `shareUrl: null`
    // and so took the other branch — so the whole HTML body (greeting, correction notice, the PM's
    // message, the signature) could be deleted and the client would receive a logo and a button, with the
    // suite completely green.
    const email = buildWeeklyReportClientEmail({
      subject: "S",
      greetingName: "Jay Stauble",
      contextParagraph: "Framing is complete on levels 3 and 4.",
      shareUrl: SHARE_URL,
      sender: { name: "Adam Sherwood", email: "adam@example.com", phone: "(214) 555-0142" },
      isCorrection: true,
    });
    expect(email.html).toContain("Hello Jay,");
    expect(email.html).toContain("This is a revised version of a report that was sent to you earlier.");
    expect(email.html).toContain("Framing is complete on levels 3 and 4.");
    expect(email.html).toContain("Adam Sherwood");
    expect(email.html).toContain("adam@example.com");
    expect(email.html).toContain("(214) 555-0142");
  });

  it("keeps a message that happens to quote the link, instead of deleting the paragraph", async () => {
    // The dedupe used to drop any paragraph CONTAINING the share URL — the whole paragraph, not the
    // duplicated sentence — and only from the HTML part. A PM who pasted the link into their own note
    // lost their entire message for every client reading HTML, while the plain-text alternative still
    // carried it: two halves of one email saying different things.
    const message = `Here is your report — you can also open it directly at ${SHARE_URL} if the button does not work.`;
    const email = buildWeeklyReportClientEmail({
      subject: "S",
      greetingName: "Jay",
      contextParagraph: message,
      shareUrl: SHARE_URL,
      sender: { name: "Adam Sherwood", email: null, phone: null },
      isCorrection: false,
    });
    expect(email.html).toContain("if the button does not work");
    expect(email.text).toContain("if the button does not work");
    // And the composed link SENTENCE is still not repeated as body text — the button carries it.
    expect(email.html).not.toContain("Here&#39;s the link to your weekly report");
    expect(email.html).not.toContain("Here's the link to your weekly report");
  });

  it("does not promise a reply path the platform does not have", async () => {
    // The footer read "Reply to this email to reach your project manager". Nothing routes a reply
    // anywhere near the PM: no Reply-To is set, so replies land on RESEND_FROM_ADDRESS, which nobody
    // watches. Carrying the PM's details in the signature is a fair trade; printing a false instruction
    // to a paying customer is not.
    const withPm = buildWeeklyReportClientEmail({
      subject: "S",
      greetingName: "Jay",
      contextParagraph: "Body.",
      shareUrl: null,
      sender: { name: "Adam Sherwood", email: "adam@example.com", phone: null },
      isCorrection: false,
    });
    expect(withPm.html).not.toMatch(/Reply to this email/i);
    expect(withPm.html).toMatch(/not monitored/i);
    expect(withPm.html).toMatch(/project manager's contact details above/i);

    // With no PM on file there are no details above to point at, so it does not point at them either.
    const withoutPm = buildWeeklyReportClientEmail({
      subject: "S",
      greetingName: null,
      contextParagraph: "Body.",
      shareUrl: null,
      sender: { name: null, email: null, phone: null },
      isCorrection: false,
    });
    expect(withoutPm.html).toMatch(/not monitored/i);
    expect(withoutPm.html).not.toMatch(/contact details above/i);
  });

  it("escapes the content it interpolates", async () => {
    const email = buildWeeklyReportClientEmail({
      subject: "S",
      greetingName: "Jay",
      contextParagraph: '<script>alert("x")</script>',
      shareUrl: null,
      sender: { name: null, email: null, phone: null },
      isCorrection: false,
    });
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
  });

  it("names the property and the week in the attachment filename, not the report uuid", () => {
    expect(
      weeklyReportAttachmentFilename({ propertyName: "4123 Cedar Springs", weekOf: "2026-08-13" }),
    ).toBe("4123 Cedar Springs - Weekly Report 2026-08-13.pdf");
  });

  it("strips characters a filesystem would refuse", () => {
    expect(weeklyReportAttachmentFilename({ propertyName: 'A/B:C"D', weekOf: "2026-08-13" })).not.toMatch(
      /[\\/:*?"<>|]/,
    );
  });
});
