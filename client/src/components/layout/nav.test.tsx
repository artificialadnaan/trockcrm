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
    role: "admin" as "admin" | "director" | "sales_manager" | "rep" | "construction",
    officeId: "office-1",
    activeOfficeId: "office-1",
  },
  logout: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => authMock,
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  authMock.user.role = "admin";
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
  it("renders sidebar Capture as an external trockcam link", async () => {
    const node = renderNode(<Sidebar />);
    await vi.waitFor(() => expect(node.querySelector("aside")).toBeTruthy());

    const captureLink = Array.from(node.querySelectorAll("a")).find((anchor) => anchor.textContent?.includes("Capture"));
    expect(captureLink?.getAttribute("href")).toBe("https://trockcam.com");
    expect(captureLink?.getAttribute("target")).toBe("_blank");
    expect(captureLink?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(captureLink?.getAttribute("aria-label")).toBe("Open Capture in a new tab");
  });

  it("renders mobile Capture as an external trockcam link", async () => {
    const node = renderNode(<MobileNav />);
    await vi.waitFor(() => expect(node.querySelector("nav")).toBeTruthy());

    const captureLink = Array.from(node.querySelectorAll("a")).find((anchor) => anchor.textContent?.includes("Capture"));
    expect(captureLink?.getAttribute("href")).toBe("https://trockcam.com");
    expect(captureLink?.getAttribute("target")).toBe("_blank");
    expect(captureLink?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(captureLink?.getAttribute("aria-label")).toBe("Open Capture in a new tab");
  });
});

describe("ticketing navigation", () => {
  it("renders sidebar Tickets as an external support link", async () => {
    const node = renderNode(<Sidebar />);
    await vi.waitFor(() => expect(node.querySelector("aside")).toBeTruthy());

    const ticketsLink = Array.from(node.querySelectorAll("a")).find((anchor) => anchor.textContent?.includes("Tickets"));
    expect(ticketsLink?.getAttribute("href")).toBe("https://support-hub-production.up.railway.app/");
    expect(ticketsLink?.getAttribute("target")).toBe("_blank");
    expect(ticketsLink?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(ticketsLink?.getAttribute("aria-label")).toBe("Open Tickets in a new tab");
  });

  it("renders mobile Tickets as an external support link", async () => {
    const node = renderNode(<MobileNav />);
    await vi.waitFor(() => expect(node.querySelector("nav")).toBeTruthy());

    const ticketsLink = Array.from(node.querySelectorAll("a")).find((anchor) => anchor.textContent?.includes("Tickets"));
    expect(ticketsLink?.getAttribute("href")).toBe("https://support-hub-production.up.railway.app/");
    expect(ticketsLink?.getAttribute("target")).toBe("_blank");
    expect(ticketsLink?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(ticketsLink?.getAttribute("aria-label")).toBe("Open Tickets in a new tab");
  });

  it("keeps the rep mobile Commissions link alongside Tickets", async () => {
    authMock.user.role = "rep";
    const node = renderNode(<MobileNav />);
    await vi.waitFor(() => expect(node.querySelector("nav")).toBeTruthy());

    const commissionsLink = Array.from(node.querySelectorAll("a")).find((anchor) => anchor.textContent?.includes("Commissions"));
    const ticketsLink = Array.from(node.querySelectorAll("a")).find((anchor) => anchor.textContent?.includes("Tickets"));

    expect(commissionsLink?.getAttribute("href")).toBe("/commissions");
    expect(ticketsLink?.getAttribute("href")).toBe("https://support-hub-production.up.railway.app/");
  });
});
