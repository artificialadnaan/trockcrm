/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarketingExpenseRequestFormPage } from "./marketing-expense-request-form-page";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  createMarketingExpenseRequest: vi.fn(),
  submitMarketingExpenseRequest: vi.fn(),
  uploadFile: vi.fn(),
  navigate: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));

vi.mock("react-router-dom", () => ({
  useNavigate: () => mocks.navigate,
  Link: ({ children, ...props }: { children: React.ReactNode }) => <a {...props}>{children}</a>,
}));

vi.mock("@/hooks/use-marketing-expense-requests", () => ({
  createMarketingExpenseRequest: mocks.createMarketingExpenseRequest,
  submitMarketingExpenseRequest: mocks.submitMarketingExpenseRequest,
}));

vi.mock("@/hooks/use-files", () => ({ uploadFile: mocks.uploadFile }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createMarketingExpenseRequest.mockResolvedValue({ id: "req-1", requestNumber: "MER-0001" });
  mocks.submitMarketingExpenseRequest.mockResolvedValue({ id: "req-1", requestNumber: "MER-0001" });
  mocks.uploadFile.mockResolvedValue({ id: "file-1" });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
  container.remove();
});

async function renderPage() {
  await act(async () => {
    root.render(<MarketingExpenseRequestFormPage />);
  });
}

function field(testId: string) {
  const element = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[data-testid="${testId}"]`,
  );
  if (!element) throw new Error(`no element with data-testid="${testId}"`);
  return element;
}

/** React 19 tracks the DOM value internally; set through the native setter or onChange never fires. */
async function type(testId: string, value: string) {
  const element = field(testId);
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(prototype.prototype, "value")!.set!;
  await act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit() {
  const button = container.querySelector<HTMLButtonElement>('[data-testid="mer-submit"]')!;
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function errorText() {
  return container.querySelector('[data-testid="mer-error"]')?.textContent ?? "";
}

async function fillRequired() {
  await type("mer-requested-by", "Reggie Rep");
  await type("mer-vendor-event", "Multifamily Expo");
  await type("mer-purpose", "Booth at the regional expo");
  await type("mer-expected-return", "Qualified leads");
}

describe("validation", () => {
  it("blocks submit and NAMES the missing field", async () => {
    await renderPage();
    await submit();
    expect(mocks.createMarketingExpenseRequest).not.toHaveBeenCalled();
    expect(errorText().toLowerCase()).toContain("requested by");
  });

  it("announces the error to assistive tech rather than only colouring it", async () => {
    await renderPage();
    await submit();
    expect(container.querySelector('[data-testid="mer-error"]')?.getAttribute("role")).toBe("alert");
  });

  it("names the vendor / event when only that is missing", async () => {
    await renderPage();
    await fillRequired();
    await type("mer-vendor-event", "   ");
    await submit();
    expect(mocks.createMarketingExpenseRequest).not.toHaveBeenCalled();
    expect(errorText().toLowerCase()).toContain("vendor");
  });

  it("names the narrative boxes, which are the ones an approver actually reads", async () => {
    await renderPage();
    await fillRequired();
    await type("mer-expected-return", "");
    await submit();
    expect(errorText().toLowerCase()).toContain("return");
  });

  it("refuses a request that asks for nothing at all", async () => {
    await renderPage();
    await fillRequired();
    await submit();
    expect(mocks.createMarketingExpenseRequest).not.toHaveBeenCalled();
    expect(errorText().toLowerCase()).toContain("cost");
  });

  it("refuses a negative amount before the server has to reject it", async () => {
    await renderPage();
    await fillRequired();
    await type("mer-cost-travel", "-5");
    await submit();
    expect(mocks.createMarketingExpenseRequest).not.toHaveBeenCalled();
    expect(errorText().toLowerCase()).toContain("travel");
  });
});

describe("the live total", () => {
  it("starts at zero", async () => {
    await renderPage();
    expect(field("mer-total").textContent).toContain("$0.00");
  });

  it("updates as each cost box is typed into", async () => {
    await renderPage();
    await type("mer-cost-advertising", "1000");
    expect(field("mer-total").textContent).toContain("$1,000.00");
    await type("mer-cost-registration", "2500.50");
    expect(field("mer-total").textContent).toContain("$3,500.50");
  });

  it("adds cents the way the SQL total does, not the way a float does", async () => {
    await renderPage();
    await type("mer-cost-advertising", "0.1");
    await type("mer-cost-registration", "0.2");
    expect(field("mer-total").textContent).toContain("$0.30");
  });

  it("counts all eight boxes", async () => {
    await renderPage();
    for (const id of [
      "advertising",
      "registration",
      "travel",
      "lodging",
      "meals",
      "materials",
      "other-1",
      "other-2",
    ]) {
      await type(`mer-cost-${id}`, "1");
    }
    expect(field("mer-total").textContent).toContain("$8.00");
  });

  it("does not read NaN while a box is half-typed", async () => {
    await renderPage();
    await type("mer-cost-advertising", "");
    expect(field("mer-total").textContent).not.toContain("NaN");
  });
});

describe("the payment method select", () => {
  it("shows the human LABEL on the trigger, never the raw column value", async () => {
    await renderPage();
    const trigger = container.querySelector('[data-testid="mer-payment-method"]');
    expect(trigger?.textContent).toContain("Not specified");
    expect(trigger?.textContent).not.toContain("invoice_ap");
  });
});

describe("the submit sequence", () => {
  async function fillValid() {
    await fillRequired();
    await type("mer-cost-advertising", "4250");
  }

  it("creates the DRAFT first, then submits — never the other way round", async () => {
    await renderPage();
    await fillValid();
    await submit();
    expect(mocks.createMarketingExpenseRequest).toHaveBeenCalledTimes(1);
    expect(mocks.submitMarketingExpenseRequest).toHaveBeenCalledWith("req-1");
    expect(mocks.createMarketingExpenseRequest.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.submitMarketingExpenseRequest.mock.invocationCallOrder[0]!,
    );
  });

  it("uploads every attachment against the new id BEFORE submitting", async () => {
    await renderPage();
    await fillValid();
    const input = container.querySelector<HTMLInputElement>('[data-testid="mer-attachments"]')!;
    const file = new File(["quote"], "quote.pdf", { type: "application/pdf" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await submit();

    expect(mocks.uploadFile).toHaveBeenCalledWith(
      expect.objectContaining({ file, marketingExpenseRequestId: "req-1" }),
    );
    // The approver must not be emailed a request whose supporting documents have not landed yet.
    expect(mocks.uploadFile.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.submitMarketingExpenseRequest.mock.invocationCallOrder[0]!,
    );
  });

  async function attach(...names: string[]) {
    const input = container.querySelector<HTMLInputElement>('[data-testid="mer-attachments"]')!;
    const files = names.map((name) => new File(["x"], name, { type: "application/pdf" }));
    Object.defineProperty(input, "files", { value: files, configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    return files;
  }

  it("does NOT submit when an attachment upload fails", async () => {
    mocks.uploadFile.mockRejectedValueOnce(new Error("network died"));
    await renderPage();
    await fillValid();
    await attach("quote.pdf");
    await submit();

    // The submitter would otherwise believe their quote is attached while the approver sees a request with
    // nothing behind it.
    expect(mocks.submitMarketingExpenseRequest).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("names the file that failed, so the error is actionable", async () => {
    mocks.uploadFile.mockRejectedValueOnce(new Error("network died"));
    await renderPage();
    await fillValid();
    await attach("quote.pdf");
    await submit();
    expect(errorText()).toContain("quote.pdf");
  });

  it("stops at the FAILED file — it does not skip past it to the rest", async () => {
    mocks.uploadFile.mockRejectedValueOnce(new Error("network died"));
    await renderPage();
    await fillValid();
    await attach("quote.pdf", "agenda.pdf");
    await submit();
    expect(mocks.uploadFile).toHaveBeenCalledTimes(1);
    expect(mocks.submitMarketingExpenseRequest).not.toHaveBeenCalled();
  });

  it("RESUMES the outstanding uploads on retry, without re-uploading what already landed", async () => {
    mocks.uploadFile
      .mockResolvedValueOnce({ id: "file-1" })
      .mockRejectedValueOnce(new Error("network died"));
    await renderPage();
    await fillValid();
    const [first, second] = await attach("quote.pdf", "agenda.pdf");
    await submit();
    expect(mocks.uploadFile).toHaveBeenCalledTimes(2);
    expect(mocks.submitMarketingExpenseRequest).not.toHaveBeenCalled();

    await submit();
    // Three calls total: the two first-attempt ones plus a retry of ONLY the file that failed.
    expect(mocks.uploadFile).toHaveBeenCalledTimes(3);
    expect(mocks.uploadFile.mock.calls[2]?.[0]).toMatchObject({ file: second });
    expect(mocks.uploadFile.mock.calls.filter((call) => call[0].file === first)).toHaveLength(1);
    expect(mocks.submitMarketingExpenseRequest).toHaveBeenCalledTimes(1);
  });

  it("does not create a second draft while retrying the uploads", async () => {
    mocks.uploadFile.mockRejectedValueOnce(new Error("network died"));
    await renderPage();
    await fillValid();
    await attach("quote.pdf");
    await submit();
    await submit();
    expect(mocks.createMarketingExpenseRequest).toHaveBeenCalledTimes(1);
  });

  it("sends the money values as STRINGS, so nothing is rounded on the way out", async () => {
    await renderPage();
    await fillValid();
    await type("mer-cost-registration", "0.10");
    await submit();
    const payload = mocks.createMarketingExpenseRequest.mock.calls[0]?.[0];
    expect(payload.costAdvertising).toBe("4250");
    expect(payload.costRegistration).toBe("0.10");
  });

  it("does NOT send a total — the server computes it in SQL", async () => {
    await renderPage();
    await fillValid();
    await submit();
    expect(mocks.createMarketingExpenseRequest.mock.calls[0]?.[0]).not.toHaveProperty("totalRequested");
  });

  it("navigates to the status page once the submit lands", async () => {
    await renderPage();
    await fillValid();
    await submit();
    expect(mocks.navigate).toHaveBeenCalledWith("/marketing-expense-requests");
  });

  it("keeps the draft and offers a RETRY when the submit fails, instead of creating a second row", async () => {
    mocks.submitMarketingExpenseRequest.mockRejectedValueOnce(new Error("No approver is configured"));
    await renderPage();
    await fillValid();
    await submit();
    expect(errorText()).toContain("No approver is configured");
    expect(mocks.navigate).not.toHaveBeenCalled();

    await submit();
    // One create, two submits: the second attempt reuses the draft it already made.
    expect(mocks.createMarketingExpenseRequest).toHaveBeenCalledTimes(1);
    expect(mocks.submitMarketingExpenseRequest).toHaveBeenCalledTimes(2);
  });

  it("disables the button while in flight so a double click cannot make two requests", async () => {
    let release: (value: unknown) => void = () => {};
    mocks.createMarketingExpenseRequest.mockImplementationOnce(
      () => new Promise((resolve) => {
        release = resolve;
      }),
    );
    await renderPage();
    await fillValid();
    const button = container.querySelector<HTMLButtonElement>('[data-testid="mer-submit"]')!;
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(button.disabled).toBe(true);
    await act(async () => {
      release({ id: "req-1", requestNumber: "MER-0001" });
    });
  });
});
