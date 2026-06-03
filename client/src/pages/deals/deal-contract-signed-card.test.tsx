/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DealContractSignedCard } from "./deal-contract-signed-card";

const mocks = vi.hoisted(() => ({
  apiMock: vi.fn(),
  toastSuccessMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: mocks.apiMock,
}));

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccessMock,
    error: mocks.toastErrorMock,
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Set a native <input type="date"> value the way the browser would and fire the
 * change React listens for. React 19 maps onChange to the bubbling `input`
 * event; we go through the native value setter so React sees the new value.
 */
function fireChange(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

// React 19 delegates onBlur to the bubbling `focusout` event at the root.
function fireBlur(input: HTMLInputElement) {
  input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
}

function fireEnter(input: HTMLInputElement) {
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
}

function makeDeal(overrides: Record<string, unknown> = {}) {
  return {
    id: "deal-1",
    contractSignedDate: null,
    ...overrides,
  } as any;
}

function getDateInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>("#contract-signed-date");
  if (!input) throw new Error("contract-signed-date input not found");
  return input;
}

describe("DealContractSignedCard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.apiMock.mockReset();
    mocks.apiMock.mockResolvedValue({ deal: {} });
    mocks.toastSuccessMock.mockReset();
    mocks.toastErrorMock.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  async function render(deal: any, onUpdate = vi.fn()) {
    await act(async () => {
      root.render(
        <DealContractSignedCard deal={deal} canEdit onUpdate={onUpdate} />
      );
    });
  }

  it("does not save while the user is typing a date — only on blur", async () => {
    await render(makeDeal());
    const input = getDateInput(container);

    // The user types month/day, then the year digit-by-digit. A native date
    // input forms a complete (but wrong) date at each intermediate year.
    await act(async () => {
      fireChange(input, "0002-01-15");
      fireChange(input, "0020-01-15");
      fireChange(input, "0202-01-15");
      fireChange(input, "2026-01-15");
    });

    // Nothing should have been persisted mid-typing.
    expect(mocks.apiMock).not.toHaveBeenCalled();

    await act(async () => {
      fireBlur(input);
    });

    // Exactly one save, with the value the user actually finished typing.
    expect(mocks.apiMock).toHaveBeenCalledTimes(1);
    expect(mocks.apiMock).toHaveBeenCalledWith("/deals/deal-1/contract-signed-date", {
      method: "PATCH",
      json: { date: "2026-01-15" },
    });
  });

  it("commits the finished value on Enter (not an intermediate)", async () => {
    await render(makeDeal());
    const input = getDateInput(container);

    await act(async () => {
      fireChange(input, "2020-01-15");
      fireChange(input, "2026-01-15");
    });
    expect(mocks.apiMock).not.toHaveBeenCalled();

    await act(async () => {
      fireEnter(input);
    });

    expect(mocks.apiMock).toHaveBeenCalledTimes(1);
    expect(mocks.apiMock).toHaveBeenCalledWith("/deals/deal-1/contract-signed-date", {
      method: "PATCH",
      json: { date: "2026-01-15" },
    });
  });

  it("does not re-PATCH on blur during an in-flight Enter commit (no double-fire)", async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    mocks.apiMock.mockImplementation(
      () => new Promise((resolve) => { resolvers.push(resolve); })
    );
    await render(makeDeal());
    const input = getDateInput(container);

    // Enter commits; its PATCH is still in flight.
    await act(async () => {
      fireChange(input, "2026-01-15");
      fireEnter(input);
    });
    expect(mocks.apiMock).toHaveBeenCalledTimes(1);

    // A native date input does NOT blur on Enter, so the user then clicks/tabs
    // away → blur fires another commit while the first is still saving. It must
    // be deferred, then dropped as a duplicate — never a second PATCH that could
    // re-fire the #612 commission/handoff side effects.
    await act(async () => {
      fireBlur(input);
    });
    expect(mocks.apiMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvers[0]({ deal: {} });
    });
    expect(mocks.apiMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolvers[1]?.({ deal: {} });
    });
  });

  it("clears the date (commits null) on explicit commit", async () => {
    await render(makeDeal({ contractSignedDate: "2026-01-15" }));
    const input = getDateInput(container);

    await act(async () => {
      fireChange(input, "");
    });
    expect(mocks.apiMock).not.toHaveBeenCalled();

    await act(async () => {
      fireBlur(input);
    });

    expect(mocks.apiMock).toHaveBeenCalledTimes(1);
    expect(mocks.apiMock).toHaveBeenCalledWith("/deals/deal-1/contract-signed-date", {
      method: "PATCH",
      json: { date: null },
    });
  });

  it("does not save when committing an unchanged value", async () => {
    await render(makeDeal({ contractSignedDate: "2026-01-15" }));
    const input = getDateInput(container);

    // User focuses then blurs without changing anything.
    await act(async () => {
      fireBlur(input);
    });

    expect(mocks.apiMock).not.toHaveBeenCalled();
  });

  it("does not suppress a save for a different deal (resets the per-deal guard)", async () => {
    const onUpdate = vi.fn();

    // Save a date on deal A.
    await act(async () => {
      root.render(
        <DealContractSignedCard deal={makeDeal({ id: "deal-A" })} canEdit onUpdate={onUpdate} />
      );
    });
    let input = getDateInput(container);
    await act(async () => {
      fireChange(input, "2026-01-15");
      fireBlur(input);
    });
    expect(mocks.apiMock).toHaveBeenCalledWith("/deals/deal-A/contract-signed-date", {
      method: "PATCH",
      json: { date: "2026-01-15" },
    });
    mocks.apiMock.mockClear();

    // Reuse the same component instance for a different deal that has no date.
    await act(async () => {
      root.render(
        <DealContractSignedCard deal={makeDeal({ id: "deal-B" })} canEdit onUpdate={onUpdate} />
      );
    });
    input = getDateInput(container);

    // Choosing the SAME date must still persist against the NEW deal.
    await act(async () => {
      fireChange(input, "2026-01-15");
      fireBlur(input);
    });
    expect(mocks.apiMock).toHaveBeenCalledTimes(1);
    expect(mocks.apiMock).toHaveBeenCalledWith("/deals/deal-B/contract-signed-date", {
      method: "PATCH",
      json: { date: "2026-01-15" },
    });
  });

  it("serializes in-flight commits so the last value wins in order", async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    mocks.apiMock.mockImplementation(
      () => new Promise((resolve) => { resolvers.push(resolve); })
    );

    await render(makeDeal());
    const input = getDateInput(container);

    // Commit X — its PATCH starts and hangs.
    await act(async () => {
      fireChange(input, "2026-01-15");
      fireBlur(input);
    });
    expect(mocks.apiMock).toHaveBeenCalledTimes(1);
    expect(mocks.apiMock).toHaveBeenLastCalledWith("/deals/deal-1/contract-signed-date", {
      method: "PATCH",
      json: { date: "2026-01-15" },
    });

    // While X is in flight, commit a DIFFERENT value Y. It must NOT start a
    // second concurrent request (that could land out of order and overwrite the
    // newer value) — it is deferred.
    await act(async () => {
      fireChange(input, "2026-02-20");
      fireBlur(input);
    });
    expect(mocks.apiMock).toHaveBeenCalledTimes(1);

    // X resolves → the deferred Y is sent, in order, and is the final write.
    await act(async () => {
      resolvers[0]({ deal: {} });
    });
    expect(mocks.apiMock).toHaveBeenCalledTimes(2);
    expect(mocks.apiMock).toHaveBeenLastCalledWith("/deals/deal-1/contract-signed-date", {
      method: "PATCH",
      json: { date: "2026-02-20" },
    });

    await act(async () => {
      resolvers[1]?.({ deal: {} });
    });
  });

  it("commits a revert to the original date made during an in-flight save", async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    mocks.apiMock.mockImplementation(
      () => new Promise((resolve) => { resolvers.push(resolve); })
    );
    await render(makeDeal({ contractSignedDate: "2026-01-15" }));
    const input = getDateInput(container);

    // Change away from the persisted date and commit (save hangs in flight).
    await act(async () => {
      fireChange(input, "2026-02-20");
      fireBlur(input);
    });
    expect(mocks.apiMock).toHaveBeenCalledTimes(1);

    // Revert back to the ORIGINAL date while the first save is still in flight.
    await act(async () => {
      fireChange(input, "2026-01-15");
      fireBlur(input);
    });
    expect(mocks.apiMock).toHaveBeenCalledTimes(1); // deferred, not concurrent

    // First save resolves → the revert must be sent (the user's last commit wins).
    await act(async () => {
      resolvers[0]({ deal: {} });
    });
    expect(mocks.apiMock).toHaveBeenCalledTimes(2);
    expect(mocks.apiMock).toHaveBeenLastCalledWith("/deals/deal-1/contract-signed-date", {
      method: "PATCH",
      json: { date: "2026-01-15" },
    });
    await act(async () => {
      resolvers[1]?.({ deal: {} });
    });
  });

  it("does not clobber an in-progress edit when the persisted prop updates while focused", async () => {
    await render(makeDeal({ contractSignedDate: null }));
    const input = getDateInput(container);

    input.focus();
    await act(async () => {
      fireChange(input, "2026-03-03");
    });
    expect(input.value).toBe("2026-03-03");

    // A prop update arrives mid-edit (e.g. a sibling refetch / a prior save
    // settling). It must not overwrite the value the user is still editing.
    await act(async () => {
      root.render(
        <DealContractSignedCard
          deal={makeDeal({ contractSignedDate: "2026-01-15" })}
          canEdit
          onUpdate={vi.fn()}
        />
      );
    });
    expect(input.value).toBe("2026-03-03");
  });

  it("allows re-saving a date after the persisted value moves away and back", async () => {
    const onUpdate = vi.fn();
    await render(makeDeal({ contractSignedDate: null }), onUpdate);
    let input = getDateInput(container);

    // Save 2026-01-15.
    await act(async () => {
      fireChange(input, "2026-01-15");
      fireBlur(input);
    });
    expect(mocks.apiMock).toHaveBeenCalledTimes(1);
    mocks.apiMock.mockClear();

    // The persisted value changes (e.g. an external edit) to a different date.
    await act(async () => {
      root.render(
        <DealContractSignedCard
          deal={makeDeal({ contractSignedDate: "2026-02-20" })}
          canEdit
          onUpdate={onUpdate}
        />
      );
    });
    input = getDateInput(container);

    // The user changes it back to 2026-01-15 — this must still PATCH.
    await act(async () => {
      fireChange(input, "2026-01-15");
      fireBlur(input);
    });
    expect(mocks.apiMock).toHaveBeenCalledTimes(1);
    expect(mocks.apiMock).toHaveBeenCalledWith("/deals/deal-1/contract-signed-date", {
      method: "PATCH",
      json: { date: "2026-01-15" },
    });
  });

  it("does not disable the input while a save is in flight", async () => {
    // Make the save hang so we can observe the input state mid-save.
    let resolveApi: (value: unknown) => void = () => {};
    mocks.apiMock.mockImplementation(
      () => new Promise((resolve) => { resolveApi = resolve; })
    );

    await render(makeDeal());
    const input = getDateInput(container);

    await act(async () => {
      fireChange(input, "2026-01-15");
    });
    // Typing must never disable the field.
    expect(input.disabled).toBe(false);

    await act(async () => {
      fireBlur(input);
    });
    // Even with the save in flight, the field stays editable.
    expect(mocks.apiMock).toHaveBeenCalledTimes(1);
    expect(input.disabled).toBe(false);

    await act(async () => {
      resolveApi({ deal: {} });
    });
  });

  it("refetches via onUpdate only after a successful commit (never mid-typing)", async () => {
    const onUpdate = vi.fn();
    await render(makeDeal(), onUpdate);
    const input = getDateInput(container);

    await act(async () => {
      fireChange(input, "2026-01-15");
    });
    // No refetch while typing — it would discard the in-progress entry.
    expect(onUpdate).not.toHaveBeenCalled();

    await act(async () => {
      fireBlur(input);
    });

    expect(onUpdate).toHaveBeenCalledTimes(1);
  });
});
