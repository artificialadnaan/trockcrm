import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// WHAT THE MAIL PROVIDER ACTUALLY RECEIVES.
//
// Every other test of this job injects `deps.sendEmail` and asserts what was PASSED to it. That is not
// what is sent: `sendSystemEmailWithMetadata` rewrites `to` under EMAIL_OVERRIDE_RECIPIENT, prefixes the
// subject, and appends SYSTEM_EMAIL_BCC to the bcc of EVERY system email. A stub cannot express any of
// that, so no test on this branch could see it — including the one property that matters most here.
//
// THE GLOBAL BCC IS DELIBERATE AND IT IS PINNED HERE. This is the first job whose recipients come from a
// CUSTOMER contact table, so SYSTEM_EMAIL_BCC — set in production to a personal mailbox — receives the
// client's report, the attached PDF and the live 180-day link, alongside the client. That was raised with
// the owner and kept. It is pinned rather than merely tolerated so that removing it, or carving out an
// exemption for this job, is a conscious act that fails a test rather than a quiet change nobody reviews.
//
// The job is driven with NO `deps.sendEmail`, so it goes through the real transport; only `resend` itself
// is mocked, at the module boundary.

const sendMock = vi.fn();

vi.stubEnv("RESEND_API_KEY", "test-resend-key");
vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(() => ({ emails: { send: sendMock } })),
}));

const { handleWeeklyReportSend } = await import("../../src/jobs/weekly-report-send.js");

const SCHEMA = "office_dallas";
const REPORT = "6b1f6f2e-9d1a-4e4a-9c2b-1f4d8a0c5e31";
const DELIVERY_KEY = "9f2a1c44-3f6b-4a2f-9d55-6e7c8b9a0d12";
const SHARE_URL = "https://reports.example.com/wr/AbCdEfGh";
const CLIENT = "jay@client-example.com";

const SILENT_LOGGER = { log: () => {}, warn: () => {}, error: () => {} };

const SEND_REQUEST = {
  recipients: [CLIENT],
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

function fakeQuery() {
  const query = vi.fn(async (sql: string) => {
    if (/^\s*SELECT/i.test(sql)) {
      return {
        rows: [
          {
            status: "sent",
            week_of: "2026-08-13",
            version: 1,
            property_display_name: "4123 Cedar Springs",
            send_request: SEND_REQUEST,
            send_delivery_key: DELIVERY_KEY,
            send_delivered_at: null,
            send_attempts: 0,
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 1 };
  });
  return query as any;
}

async function deliver() {
  await handleWeeklyReportSend(
    { reportId: REPORT, officeSlug: "dallas", tenantSchema: SCHEMA, deliveryKey: DELIVERY_KEY },
    null,
    {
      query: fakeQuery(),
      resolvePdfKey: async () => "office_dallas/report.pdf",
      getPdf: async () => Buffer.from("%PDF-1.7 pretend"),
      logger: SILENT_LOGGER,
    },
  );
}

beforeEach(() => {
  sendMock.mockReset();
  sendMock.mockResolvedValue({ data: { id: "msg_1" } });
  vi.stubEnv("NODE_ENV", "production");
  // This job refuses to email a customer from a deployment that has not explicitly opted in, so the cases
  // below stand in for an AUTHORISED production worker. NODE_ENV is not that opt-in and never could be:
  // Dockerfile.worker bakes `production` into the image, so it reads the same on a staging worker running
  // that image as it does here. See assertMayEmailRealClients.
  vi.stubEnv("WEEKLY_REPORT_CLIENT_EMAIL_ENABLED", "true");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("RESEND_API_KEY", "test-resend-key");
});

describe("what Resend is actually handed", () => {
  it("BCCs the global monitoring address on the client's own report — deliberately", async () => {
    // Read this before changing it. The client's weekly report, the PDF and a live unauthenticated link
    // to it are copied to SYSTEM_EMAIL_BCC, which in production is an internal personal mailbox. That is
    // the accepted behaviour for this job, not an oversight — and the reason it is asserted is that it
    // was previously invisible to every test in the package.
    vi.stubEnv("SYSTEM_EMAIL_BCC", "monitor@trockconstruction.com");
    await deliver();

    const payload = sendMock.mock.calls[0]![0];
    expect(payload.to).toEqual([CLIENT]);
    expect(payload.bcc).toEqual(["monitor@trockconstruction.com"]);
  });

  it("delivers to the client with no bcc when none is configured", async () => {
    vi.stubEnv("SYSTEM_EMAIL_BCC", "");
    await deliver();

    const payload = sendMock.mock.calls[0]![0];
    expect(payload.to).toEqual([CLIENT]);
    expect(payload.bcc).toBeUndefined();
  });

  it("sends nothing to the client at all when EMAIL_OVERRIDE_RECIPIENT is set", async () => {
    // The staging/local safety net, asserted end to end rather than assumed. Note the override also
    // suppresses the global bcc — the redirect is total.
    vi.stubEnv("EMAIL_OVERRIDE_RECIPIENT", "dev@trockconstruction.com");
    vi.stubEnv("SYSTEM_EMAIL_BCC", "monitor@trockconstruction.com");
    await deliver();

    const payload = sendMock.mock.calls[0]![0];
    expect(payload.to).toEqual(["dev@trockconstruction.com"]);
    expect(payload.bcc).toBeUndefined();
    expect(payload.subject).toContain(`[-> ${CLIENT}]`);
  });

  it("carries the report itself: the link, the PDF and both body parts", async () => {
    vi.stubEnv("SYSTEM_EMAIL_BCC", "");
    await deliver();

    const payload = sendMock.mock.calls[0]![0];
    expect(payload.html).toContain(SHARE_URL);
    expect(payload.text).toContain(SHARE_URL);
    expect(payload.html).toContain("Hello Jay,");
    expect(payload.subject).toBe(SEND_REQUEST.subject);
    expect(payload.attachments?.[0]?.filename).toBe(
      "4123 Cedar Springs - Weekly Report 2026-08-13.pdf",
    );
  });

  it("passes the delivery key through as the provider's idempotency key", async () => {
    vi.stubEnv("SYSTEM_EMAIL_BCC", "");
    await deliver();
    expect(sendMock.mock.calls[0]![1]).toEqual({
      idempotencyKey: `weekly-report-${SCHEMA}-${REPORT}-${DELIVERY_KEY}`,
    });
  });

  it("treats a Resend error as a failure rather than a delivery", async () => {
    // `sendSystemEmailWithMetadata` returns `{ success: false }` for a provider error instead of
    // throwing, which a handler reading only the throw would stamp as delivered.
    vi.stubEnv("SYSTEM_EMAIL_BCC", "");
    sendMock.mockResolvedValue({ error: { name: "rate_limit_exceeded" } });
    await expect(deliver()).rejects.toThrow();
  });
});
