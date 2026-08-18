import { describe, expect, it, vi } from "vitest";
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
    const sendEmail = vi.fn(async () => ({ success: false, messageId: null }));

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

  it("truncates a runaway provider message rather than writing an unbounded row", async () => {
    const { query, updates } = fakeQuery(baseRow());
    const sendEmail = vi.fn(async () => {
      throw new Error("x".repeat(5000));
    });
    await expect(
      handleWeeklyReportSend(payload(), null, {
        query,
        sendEmail,
        resolvePdfKey: async () => null,
        logger: SILENT_LOGGER,
      }),
    ).rejects.toThrow();
    expect(String(updates.find((u) => u.sql.includes("send_attempts"))!.params[1])).toHaveLength(500);
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
