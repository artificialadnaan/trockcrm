// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the API layer so no network happens; vi.hoisted lets the factory reference the spy.
const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: apiMock }));

import { openFile } from "./use-files";

describe("openFile", () => {
  beforeEach(() => {
    apiMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens a blank tab SYNCHRONOUSLY (before the fetch resolves), then navigates it to the inline URL", async () => {
    const fakeTab: { location: { href: string }; opener: unknown; close: ReturnType<typeof vi.fn> } = {
      location: { href: "about:blank" },
      opener: {},
      close: vi.fn(),
    };
    const openSpy = vi.spyOn(window, "open").mockReturnValue(fakeTab as unknown as Window);

    // Hold the fetch open so we can prove the tab is opened before it resolves (popup-blocker safety).
    let resolveApi: (v: { url: string; filename: string }) => void = () => {};
    apiMock.mockReturnValue(new Promise((r) => { resolveApi = r; }));

    const p = openFile("f1");

    // Synchronous: the tab is already open on about:blank, and opener is neutralized (anti-tabnabbing).
    expect(openSpy).toHaveBeenCalledWith("about:blank", "_blank");
    expect(fakeTab.location.href).toBe("about:blank");
    expect(fakeTab.opener).toBeNull();

    resolveApi({ url: "https://r2/inline.pdf", filename: "x.pdf" });
    await p;

    // Requested with preview=1 so an inline open is audited as a preview, not a download.
    expect(apiMock).toHaveBeenCalledWith("/files/f1/download?disposition=inline&preview=1");
    expect(fakeTab.location.href).toBe("https://r2/inline.pdf");
  });

  it("closes the pre-opened tab when the fetch fails", async () => {
    const fakeTab = { location: { href: "about:blank" }, opener: {}, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(fakeTab as unknown as Window);
    apiMock.mockRejectedValue(new Error("boom"));

    await expect(openFile("f1")).rejects.toThrow("boom");
    expect(fakeTab.close).toHaveBeenCalled();
  });
});
