// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const getSignature = vi.fn();
vi.mock("@/hooks/use-signature", () => ({
  getSignature: (...args: unknown[]) => getSignature(...args),
  saveSignature: vi.fn(),
  uploadSignatureLogo: vi.fn(),
}));

import { SignatureSettings } from "./signature-settings";

let container: HTMLDivElement;
let root: Root;

function saveButton(): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((b) => /save signature/i.test(b.textContent ?? "")) as
    | HTMLButtonElement
    | undefined;
}

async function mountAndSettle() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<SignatureSettings />);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0)); // flush getSignature then/catch/finally + re-render
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("SignatureSettings", () => {
  it("on load failure: shows an error and keeps Save DISABLED (no accidental clear of a stored signature)", async () => {
    getSignature.mockRejectedValue(new Error("500"));
    await mountAndSettle();
    expect(container.textContent).toMatch(/couldn't load your signature/i);
    expect(saveButton()?.disabled).toBe(true);
  });

  it("enables Save after a successful load", async () => {
    getSignature.mockResolvedValue("<p>hi</p>");
    await mountAndSettle();
    expect(container.textContent ?? "").not.toMatch(/couldn't load/i);
    expect(saveButton()?.disabled).toBe(false);
  });
});
