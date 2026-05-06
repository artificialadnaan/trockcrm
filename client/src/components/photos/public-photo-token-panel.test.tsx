/**
 * @vitest-environment jsdom
 */
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicPhotoTokenPanel } from "./public-photo-token-panel";

const apiMock = vi.hoisted(() => vi.fn());
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("sonner", () => ({ toast: toastMock }));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = "";
  apiMock.mockReset();
  toastMock.success.mockReset();
  toastMock.error.mockReset();
});

function renderPanel() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(<PublicPhotoTokenPanel dealId="deal-1" />);
  return container;
}

async function clickButton(label: string) {
  await vi.waitFor(() => {
    const button = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.includes(label));
    expect(button).toBeTruthy();
    button!.click();
  });
}

describe("PublicPhotoTokenPanel", () => {
  it("loads and renders existing public photo tokens", async () => {
    apiMock.mockResolvedValue({
      tokens: [{
        id: "token-1",
        createdBy: { id: "admin-1", name: "Admin User" },
        createdAt: "2026-05-01T00:00:00.000Z",
        expiresAt: null,
        revokedAt: null,
        lastAccessedAt: null,
        accessCount: 2,
        status: "active",
      }],
    });

    renderPanel();
    await clickButton("Share");

    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith("/admin/deals/deal-1/photo-tokens"));
    await vi.waitFor(() => expect(document.body.textContent).toContain("active"));
    expect(document.body.textContent).toContain("Admin User");
    expect(document.body.textContent).toContain("2 accesses");
  });

  it("creates a public token, displays the one-time URL, copies it, and refreshes the list", async () => {
    apiMock
      .mockResolvedValueOnce({ tokens: [] })
      .mockResolvedValueOnce({ url: "https://crm.trock.test/p/raw-token" })
      .mockResolvedValueOnce({
        tokens: [{
          id: "token-1",
          createdBy: { id: "admin-1", name: "Admin User" },
          createdAt: "2026-05-01T00:00:00.000Z",
          expiresAt: null,
          revokedAt: null,
          lastAccessedAt: null,
          accessCount: 0,
          status: "active",
        }],
      });

    renderPanel();
    await clickButton("Share");
    await vi.waitFor(() => expect(document.body.textContent).toContain("No public links"));

    await clickButton("Create new link");

    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith("/admin/deals/deal-1/photo-tokens", { method: "POST", json: {} }));
    await vi.waitFor(() => expect(document.body.querySelector<HTMLInputElement>('input[readonly]')?.value).toBe("https://crm.trock.test/p/raw-token"));
    const copyButton = document.body.querySelector<HTMLInputElement>('input[readonly]')?.parentElement?.querySelector<HTMLButtonElement>("button");
    expect(copyButton).toBeTruthy();
    copyButton!.click();
    await vi.waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("https://crm.trock.test/p/raw-token"));
    expect(toastMock.success).toHaveBeenCalledWith("Copied public photo link");
  });

  it("revokes an active token and refreshes the list", async () => {
    apiMock
      .mockResolvedValueOnce({
        tokens: [{
          id: "token-1",
          createdBy: { id: "admin-1", name: "Admin User" },
          createdAt: "2026-05-01T00:00:00.000Z",
          expiresAt: null,
          revokedAt: null,
          lastAccessedAt: null,
          accessCount: 1,
          status: "active",
        }],
      })
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({
        tokens: [{
          id: "token-1",
          createdBy: { id: "admin-1", name: "Admin User" },
          createdAt: "2026-05-01T00:00:00.000Z",
          expiresAt: null,
          revokedAt: "2026-05-02T00:00:00.000Z",
          lastAccessedAt: null,
          accessCount: 1,
          status: "revoked",
        }],
      });

    renderPanel();
    await clickButton("Share");
    await vi.waitFor(() => expect(document.body.textContent).toContain("active"));

    await clickButton("Revoke");

    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith("/admin/photo-tokens/token-1/revoke", { method: "POST", json: {} }));
    await vi.waitFor(() => expect(document.body.textContent).toContain("revoked"));
  });

  it("surfaces load, create, and revoke errors through toast", async () => {
    apiMock.mockRejectedValueOnce(new Error("load failed"));
    renderPanel();
    await clickButton("Share");
    await vi.waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("load failed"));

    apiMock.mockResolvedValueOnce({ tokens: [] }).mockRejectedValueOnce(new Error("create failed"));
    await clickButton("Refresh");
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith("/admin/deals/deal-1/photo-tokens"));
    await clickButton("Create new link");
    await vi.waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("create failed"));
  });
});
