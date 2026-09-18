// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchWeeklyReportSendDraft: vi.fn(),
  sendWeeklyReport: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/hooks/use-weekly-reports", () => ({
  fetchWeeklyReportSendDraft: mocks.fetchWeeklyReportSendDraft,
  sendWeeklyReport: mocks.sendWeeklyReport,
}));
vi.mock("sonner", () => ({ toast: { error: mocks.toastError, success: mocks.toastSuccess } }));

import { WeeklyReportSendDialog } from "./weekly-report-send-dialog";

const DRAFT = {
  reportId: "report-1",
  weekOf: "2026-08-13",
  version: 1,
  isCorrection: false,
  propertyName: "4123 Cedar Springs",
  recipients: ["jay@example.com", "melissa@example.com"],
  recipientOptions: [
    { role: "DOC", name: "Jay Stauble", email: "jay@example.com" },
    { role: "PM", name: "Melissa Garcia", email: "melissa@example.com" },
  ],
  subject: "4123 Cedar Springs — Weekly Progress Report, Week of 8/13/26",
  greeting: "Hello Jay,",
  contextParagraph: "Please find this week's progress report.",
  sender: { name: "Adam Sherwood", email: "adam@trockconstruction.com", phone: "(214) 555-0142" },
  attachPdf: true,
  bodyPreview: "Hello Jay,\n\nPlease find this week's progress report.",
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.fetchWeeklyReportSendDraft.mockReset();
  mocks.sendWeeklyReport.mockReset();
  mocks.toastError.mockReset();
  mocks.toastSuccess.mockReset();
  mocks.fetchWeeklyReportSendDraft.mockResolvedValue(DRAFT);
  mocks.sendWeeklyReport.mockResolvedValue({
    report: { id: "report-1", status: "sent" },
    shareUrl: "https://reports.example.com/wr/AbCdEfGh",
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render() {
  await act(async () => {
    root.render(<WeeklyReportSendDialog reportId="report-1" onClose={vi.fn()} onSent={vi.fn()} />);
  });
}

/** The dialog renders through a portal, so its nodes live on document.body. */
function input(label: string): HTMLInputElement {
  const found = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!found) throw new Error(`input ${label} not found`);
  return found;
}
function textarea(label: string): HTMLTextAreaElement {
  const found = document.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`);
  if (!found) throw new Error(`textarea ${label} not found`);
  return found;
}
function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label,
  );
  if (!match) throw new Error(`button ${label} not found`);
  return match as HTMLButtonElement;
}
function removeRecipient(email: string) {
  const remove = document.querySelector<HTMLButtonElement>(`button[aria-label="Remove ${email}"]`);
  if (!remove) throw new Error(`remove button for ${email} not found`);
  remove.click();
}
function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype =
    element instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("the modal renders what the SERVER composed", () => {
  it("shows the server's subject, greeting, message and recipients rather than building its own", async () => {
    // The whole reason the draft is a server call: T-Rock Cam will render the same payload, and anything
    // this component assembled itself would be a second implementation the two surfaces could drift on.
    await render();
    expect(input("Subject").value).toBe(DRAFT.subject);
    expect(textarea("Message").value).toBe(DRAFT.contextParagraph);
    expect(document.body.textContent).toContain("Hello Jay,");
    expect(document.body.textContent).toContain("jay@example.com");
    expect(document.body.textContent).toContain("(214) 555-0142");
  });

  it("warns when the project has no PM, so the client would get nobody to reply to", async () => {
    mocks.fetchWeeklyReportSendDraft.mockResolvedValue({
      ...DRAFT,
      sender: { name: null, email: null, phone: null },
    });
    await render();
    expect(document.body.textContent).toMatch(/no T-Rock PM on file/i);
  });

  it("RECOMPUTES the greeting as the PM edits the recipients", async () => {
    // The server picks the greeting from the recipients it is FINALLY given, and does so deliberately.
    // The modal rendered `draft.greeting`, computed from the PRE-FILLED list — so removing the DOC left
    // the PM approving "Hello Jay," for an email the client would read as "Hello Melissa,". On a modal
    // whose whole premise is that the PM approves exactly what the client receives, that is the one line
    // that must not be a guess.
    await render();
    expect(document.body.textContent).toContain("Hello Jay,");

    await act(async () => {
      removeRecipient("jay@example.com");
    });
    expect(document.body.textContent).toContain("Hello Melissa,");
    expect(document.body.textContent).not.toContain("Hello Jay,");
  });

  it("falls back to a generic greeting for an address it cannot attribute", async () => {
    await render();
    await act(async () => {
      removeRecipient("jay@example.com");
    });
    await act(async () => {
      removeRecipient("melissa@example.com");
    });
    setValue(input("Add a recipient"), "someone@elsewhere.com");
    await act(async () => {
      button("Add").click();
    });
    expect(document.body.textContent).toContain("Hello,");
    expect(document.body.textContent).not.toContain("Hello Melissa,");
  });

  it("says a correction replaces what the client already has", async () => {
    mocks.fetchWeeklyReportSendDraft.mockResolvedValue({ ...DRAFT, isCorrection: true, version: 2 });
    await render();
    expect(document.body.textContent).toMatch(/Send correction to client/i);
    expect(document.body.textContent).toMatch(/replaces the copy they already have/i);
  });

  it("does NOT claim to replace anything when the earlier version never reached the client", async () => {
    // A v2 exists for two very different reasons — the content was wrong, or the v1 email never got out.
    // Only the first replaces something. The server decides which, on the same predicate the email uses,
    // and the modal must not announce a correction the client will not be told about.
    mocks.fetchWeeklyReportSendDraft.mockResolvedValue({ ...DRAFT, isCorrection: false, version: 2 });
    await render();
    expect(document.body.textContent).toMatch(/Send weekly report to client/i);
    expect(document.body.textContent).toMatch(/never reached the client/i);
    expect(document.body.textContent).not.toMatch(/replaces the copy they already have/i);
  });
});

describe("sending", () => {
  it("posts exactly what the PM edited", async () => {
    await render();
    setValue(textarea("Message"), "Framing wrapped up on 3 and 4.");
    setValue(input("Subject"), "Cedar Springs weekly");
    await act(async () => {
      button("Send to client").click();
    });

    expect(mocks.sendWeeklyReport).toHaveBeenCalledWith("report-1", {
      recipients: ["jay@example.com", "melissa@example.com"],
      subject: "Cedar Springs weekly",
      contextParagraph: "Framing wrapped up on 3 and 4.",
      attachPdf: true,
    });
  });

  it("INCLUDES a typed-but-not-added recipient", async () => {
    // The data-loss bug, and it is worse here than on the settings dialog: the address that gets dropped
    // belongs to a client the PM believes has just been sent their report.
    await render();
    setValue(input("Add a recipient"), "owner@client.com");
    await act(async () => {
      button("Send to client").click();
    });

    expect(mocks.sendWeeklyReport.mock.calls[0]![1].recipients).toEqual([
      "jay@example.com",
      "melissa@example.com",
      "owner@client.com",
    ]);
  });

  it("refuses a malformed pending address rather than silently dropping it", async () => {
    await render();
    setValue(input("Add a recipient"), "not-an-email");
    await act(async () => {
      button("Send to client").click();
    });
    expect(mocks.sendWeeklyReport).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalled();
  });

  it("does not send to nobody when every recipient has been removed", async () => {
    await render();
    await act(async () => {
      removeRecipient("jay@example.com");
    });
    await act(async () => {
      removeRecipient("melissa@example.com");
    });
    await act(async () => {
      button("Send to client").click();
    });
    expect(mocks.sendWeeklyReport).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalled();
  });

  it("carries the PDF toggle through as posted", async () => {
    await render();
    const checkbox = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => {
      checkbox.click();
    });
    await act(async () => {
      button("Send to client").click();
    });
    expect(mocks.sendWeeklyReport.mock.calls[0]![1].attachPdf).toBe(false);
  });

  it("shows the real client link afterwards — the one moment it is copyable", async () => {
    // Only the token's HASH is stored, so if the PM does not take the URL here it cannot be recovered
    // from the database. Closing straight after send would throw it away.
    await render();
    await act(async () => {
      button("Send to client").click();
    });
    expect(input("Client link").value).toBe("https://reports.example.com/wr/AbCdEfGh");
    expect(document.body.textContent).toMatch(/Send failed/i);
  });

  it("keeps the modal usable when the send is refused", async () => {
    mocks.sendWeeklyReport.mockRejectedValue(new Error("A report has to be approved by the PM"));
    await render();
    await act(async () => {
      button("Send to client").click();
    });
    expect(mocks.toastError).toHaveBeenCalledWith("A report has to be approved by the PM");
    // Still on the form, not on the success panel — the PM can fix and retry.
    expect(input("Subject").value).toBe(DRAFT.subject);
  });

  it("surfaces a draft that could not be loaded instead of an empty dialog", async () => {
    mocks.fetchWeeklyReportSendDraft.mockRejectedValue(new Error("Only the assigned project manager"));
    await render();
    expect(document.body.textContent).toContain("Only the assigned project manager");
  });
});
