/**
 * @vitest-environment jsdom
 */
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./sidebar";
import { MobileNav } from "./mobile-nav";

const authMock = vi.hoisted(() => ({
  user: {
    id: "admin-1",
    displayName: "Admin User",
    email: "admin@example.com",
    role: "admin" as const,
    officeId: "office-1",
    activeOfficeId: "office-1",
  },
  logout: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => authMock,
}));

vi.mock("@/lib/field-app", () => ({
  buildFieldCaptureUrl: () => "https://field.example.com/capture",
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
});

function renderNode(node: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(<MemoryRouter>{node}</MemoryRouter>);
  return container;
}

describe("capture navigation", () => {
  it("links sidebar Capture to the field app when configured", async () => {
    const node = renderNode(<Sidebar />);
    await vi.waitFor(() => expect(node.querySelector('[data-capture-nav="field-app"]')).toBeTruthy());

    const captureLink = Array.from(node.querySelectorAll("a")).find((anchor) => anchor.textContent?.includes("Capture"));
    expect(captureLink?.getAttribute("href")).toBe("https://field.example.com/capture");
  });

  it("links mobile Capture to the field app when configured", async () => {
    const node = renderNode(<MobileNav />);
    await vi.waitFor(() => expect(node.querySelector('[data-capture-nav="field-app"]')).toBeTruthy());

    const captureLink = Array.from(node.querySelectorAll("a")).find((anchor) => anchor.textContent?.includes("Capture"));
    expect(captureLink?.getAttribute("href")).toBe("https://field.example.com/capture");
  });
});
