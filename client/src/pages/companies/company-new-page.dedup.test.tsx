// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyNewPage } from "./company-new-page";

const mocks = vi.hoisted(() => ({
  createCompanyMock: vi.fn(),
  navigateMock: vi.fn(),
}));

vi.mock("@/hooks/use-companies", () => ({
  createCompany: mocks.createCompanyMock,
}));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => mocks.navigateMock };
});

let container: HTMLDivElement;
let root: Root;

function setInputValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function clickByText(text: string) {
  const btn = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text
  );
  if (!btn) throw new Error(`button "${text}" not found`);
  act(() => {
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  mocks.createCompanyMock.mockReset();
  mocks.navigateMock.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(
      <MemoryRouter>
        <CompanyNewPage />
      </MemoryRouter>
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function submitName(name: string) {
  const nameInput = container.querySelector<HTMLInputElement>("#name")!;
  act(() => setInputValue(nameInput, name));
  const form = container.querySelector("form")!;
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("CompanyNewPage — duplicate warning flow", () => {
  it("shows the warning (does not navigate) when the server flags a duplicate", async () => {
    mocks.createCompanyMock.mockResolvedValueOnce({
      company: null,
      dedupWarning: true,
      suggestions: [
        { id: "co-acme", name: "Acme Roofing", address: "100 Oak St", city: "Dallas", state: "TX", zip: "75201", dealCount: 12, matchReason: "Exact name match" },
      ],
    });

    await submitName("Acme Roofing");

    expect(container.textContent).toContain("Possible duplicate company found");
    expect(container.textContent).toContain("Acme Roofing");
    expect(container.textContent).toContain("12 deals");
    expect(mocks.navigateMock).not.toHaveBeenCalled();
  });

  it("navigates to the existing company when the rep picks 'Use This Company'", async () => {
    mocks.createCompanyMock.mockResolvedValueOnce({
      company: null,
      dedupWarning: true,
      suggestions: [
        { id: "co-acme", name: "Acme Roofing", address: null, city: null, state: null, zip: null, dealCount: 1, matchReason: "Exact name match" },
      ],
    });

    await submitName("Acme Roofing");
    clickByText("Use This Company");

    expect(mocks.navigateMock).toHaveBeenCalledWith("/companies/co-acme");
  });

  it("re-submits with skipDedupCheck=true and navigates to the new company on 'Create Anyway'", async () => {
    mocks.createCompanyMock
      .mockResolvedValueOnce({
        company: null,
        dedupWarning: true,
        suggestions: [
          { id: "co-acme", name: "Acme Roofing", address: null, city: null, state: null, zip: null, dealCount: 0, matchReason: "Exact name match" },
        ],
      })
      .mockResolvedValueOnce({ company: { id: "co-new", name: "Acme Roofing" } });

    await submitName("Acme Roofing");
    await act(async () => {
      clickByText("Create Anyway");
    });

    expect(mocks.createCompanyMock).toHaveBeenCalledTimes(2);
    expect(mocks.createCompanyMock.mock.calls[1][0]).toMatchObject({ skipDedupCheck: true });
    expect(mocks.navigateMock).toHaveBeenCalledWith("/companies/co-new");
  });

  it("navigates straight to the new company when there is no duplicate", async () => {
    mocks.createCompanyMock.mockResolvedValueOnce({ company: { id: "co-fresh", name: "Lone Star Exteriors" } });

    await submitName("Lone Star Exteriors");

    expect(mocks.createCompanyMock.mock.calls[0][0]).toMatchObject({ skipDedupCheck: false });
    expect(mocks.navigateMock).toHaveBeenCalledWith("/companies/co-fresh");
  });
});
