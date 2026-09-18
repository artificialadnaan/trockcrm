import {
  createWeeklyReport,
  createWeeklyReportCorrection,
  getWeeklyReport,
  getWeeklyReportAssignments,
  getWeeklyReportPhotoCandidates,
  getWeeklyReportSendDraft,
  replaceWeeklyReportPhotos,
  retryWeeklyReportSend,
  sendWeeklyReport,
  transitionWeeklyReport,
  updateWeeklyReport,
  type Fetcher,
} from "../endpoints";

type Call = { path: string; opts: Parameters<Fetcher>[1] };

function recorder() {
  const calls: Call[] = [];
  const fetcher: Fetcher = async (path, opts) => {
    calls.push({ path, opts });
    return {} as never;
  };
  return { calls, fetcher };
}

const REPORT = "00000000-0000-4000-8000-000000000001";

describe("weekly-report endpoints", () => {
  /**
   * THE trap this file exists for.
   *
   * This app signs in through `/auth/field-login`, which mints a `surface: "field"` token the server
   * rejects on every CRM route by design (#722) — and the CRM weekly-report router is additionally gated
   * to admin/director/rep, so a superintendent could never reach it even with a CRM session. Addressed at
   * `/weekly-reports` these all 401, the client reads 401 as a dead session and signs the user out, and
   * one unfilable report locks the crew out of the app. That is the glasses-walkthrough defect, which
   * shipped through five review rounds because both sides were tested against mocks that agreed with each
   * other rather than with the auth boundary between them.
   */
  it("addresses EVERY call to the field surface", async () => {
    const { calls, fetcher } = recorder();

    await getWeeklyReportAssignments(fetcher);
    await createWeeklyReport(fetcher, {
      clientSubmissionId: "sub",
      weeklyReportProjectId: "wrp",
      weekOf: "2026-08-13",
    });
    await getWeeklyReport(fetcher, REPORT);
    await updateWeeklyReport(fetcher, REPORT, { workCompleted: "x" });
    await getWeeklyReportPhotoCandidates(fetcher, REPORT);
    await replaceWeeklyReportPhotos(fetcher, REPORT, []);
    await transitionWeeklyReport(fetcher, REPORT, "pending_review");
    // The send, which has CRM counterparts gated admin/director — the one place addressing the wrong
    // mount would look like a permission problem rather than a routing one, and the one place where
    // "the PM cannot do this" is the exact bug these four exist to fix.
    await getWeeklyReportSendDraft(fetcher, REPORT);
    await sendWeeklyReport(fetcher, REPORT, {
      recipients: ["jay@example.com"],
      subject: "s",
      contextParagraph: "c",
      attachPdf: true,
    });
    await retryWeeklyReportSend(fetcher, REPORT);
    await createWeeklyReportCorrection(fetcher, REPORT);

    expect(calls).toHaveLength(11);
    for (const call of calls) {
      expect(call.path.startsWith("/field/weekly-reports/")).toBe(true);
    }
  });

  it("posts the send exactly as composed, with nothing invented client-side", async () => {
    const { calls, fetcher } = recorder();
    await sendWeeklyReport(fetcher, REPORT, {
      recipients: ["jay@example.com", "melissa@example.com"],
      subject: "4123 Cedar Springs — Weekly Progress Report",
      contextParagraph: "Week 3 update attached.",
      attachPdf: true,
    });
    expect(calls[0]).toEqual({
      path: `/field/weekly-reports/reports/${REPORT}/send`,
      opts: {
        method: "POST",
        body: {
          recipients: ["jay@example.com", "melissa@example.com"],
          subject: "4123 Cedar Springs — Weekly Progress Report",
          contextParagraph: "Week 3 update attached.",
          attachPdf: true,
        },
      },
    });
  });

  it("defaults the retry's duplicate-risk acknowledgement to FALSE", async () => {
    // Silence must mean the safe answer. Past the mail provider's 24-hour idempotency window a replay is a
    // genuinely second email to a paying client, and the server refuses without this flag rather than
    // trusting the caller to have asked first — so a client that sent `true` by default would turn a
    // deliberate act into an accidental one.
    const { calls, fetcher } = recorder();
    await retryWeeklyReportSend(fetcher, REPORT);
    expect(calls[0]).toEqual({
      path: `/field/weekly-reports/reports/${REPORT}/send/retry`,
      opts: { method: "POST", body: { acknowledgeDuplicateRisk: false } },
    });

    await retryWeeklyReportSend(fetcher, REPORT, true);
    expect(calls[1].opts).toEqual({ method: "POST", body: { acknowledgeDuplicateRisk: true } });
  });

  it("posts the idempotency key with the create, so a lost response cannot double-file a week", async () => {
    const { calls, fetcher } = recorder();
    await createWeeklyReport(fetcher, {
      clientSubmissionId: "sub-1",
      weeklyReportProjectId: "wrp-1",
      weekOf: "2026-08-13",
    });
    expect(calls[0]).toEqual({
      path: "/field/weekly-reports/reports",
      opts: {
        method: "POST",
        body: { clientSubmissionId: "sub-1", weeklyReportProjectId: "wrp-1", weekOf: "2026-08-13" },
      },
    });
  });

  it("PATCHes content and passes an explicit null straight through", async () => {
    // An omitted key leaves the previous text in place server-side, so a section the author CLEARED has
    // to travel as null or the client's report keeps printing something they deleted.
    const { calls, fetcher } = recorder();
    await updateWeeklyReport(fetcher, REPORT, {
      workCompleted: "- Slab poured",
      nextWeekLookAhead: null,
      completionPercent: 12.5,
      weatherDelayDays: null,
    });
    expect(calls[0]).toEqual({
      path: `/field/weekly-reports/reports/${REPORT}`,
      opts: {
        method: "PATCH",
        body: {
          workCompleted: "- Slab poured",
          nextWeekLookAhead: null,
          completionPercent: 12.5,
          weatherDelayDays: null,
        },
      },
    });
  });

  it("PUTs the whole photo selection, order intact", async () => {
    const { calls, fetcher } = recorder();
    await replaceWeeklyReportPhotos(fetcher, REPORT, [
      { fileId: "b", caption: "Balcony" },
      { fileId: "a", caption: null },
    ]);
    expect(calls[0]).toEqual({
      path: `/field/weekly-reports/reports/${REPORT}/photos`,
      opts: {
        method: "PUT",
        body: { photos: [{ fileId: "b", caption: "Balcony" }, { fileId: "a", caption: null }] },
      },
    });
  });

  it("sends an EMPTY selection as an explicit empty array", async () => {
    // The server refuses a malformed payload rather than coercing it, precisely so `{"photos":"oops"}`
    // cannot silently delete a report's photos. Clearing has to be an explicit [].
    const { calls, fetcher } = recorder();
    await replaceWeeklyReportPhotos(fetcher, REPORT, []);
    expect(calls[0].opts).toEqual({ method: "PUT", body: { photos: [] } });
  });

  it("posts a transition as an INTENT, never as a status write", async () => {
    const { calls, fetcher } = recorder();
    await transitionWeeklyReport(fetcher, REPORT, "approved");
    expect(calls[0]).toEqual({
      path: `/field/weekly-reports/reports/${REPORT}/transition`,
      opts: { method: "POST", body: { to: "approved" } },
    });
  });
});
