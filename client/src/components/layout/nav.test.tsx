/**
 * @vitest-environment jsdom
 */
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./sidebar";
import { MobileNav } from "./mobile-nav";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
});

function renderNode(node: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<MemoryRouter>{node}</MemoryRouter>);
  });
  return container;
}

function findLink(node: HTMLElement, label: string) {
  // Exact trimmed text so e.g. "Commissions" never resolves to "Team Commissions".
  return Array.from(node.querySelectorAll("a")).find((anchor) => anchor.textContent?.trim() === label);
}

function openMore(node: HTMLElement) {
  const moreButton = node.querySelector<HTMLButtonElement>("button[aria-label='More navigation']");
  expect(moreButton).toBeTruthy();
  act(() => {
    moreButton!.click();
  });
}

describe("capture navigation", () => {
  it("renders sidebar Capture as an external trockcam link", () => {
    const node = renderNode(<Sidebar />);
    const captureLink = findLink(node, "Capture");
    expect(captureLink?.getAttribute("href")).toBe("https://trockcam.com");
    expect(captureLink?.getAttribute("target")).toBe("_blank");
    expect(captureLink?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(captureLink?.getAttribute("aria-label")).toBe("Open Capture in a new tab");
  });

  it("renders mobile Capture as an external trockcam link inside More", () => {
    const node = renderNode(<MobileNav />);
    // Capture is not a primary tab; it lives behind More.
    expect(findLink(node, "Capture")).toBeUndefined();

    openMore(node);

    const captureLink = findLink(node, "Capture");
    expect(captureLink?.getAttribute("href")).toBe("https://trockcam.com");
    expect(captureLink?.getAttribute("target")).toBe("_blank");
    expect(captureLink?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(captureLink?.getAttribute("aria-label")).toBe("Open Capture in a new tab");
  });
});

describe("ticketing navigation", () => {
  it("renders sidebar Tickets as an external support link", () => {
    const node = renderNode(<Sidebar />);
    const ticketsLink = findLink(node, "Tickets");
    expect(ticketsLink?.getAttribute("href")).toBe("https://support-hub-production.up.railway.app/");
    expect(ticketsLink?.getAttribute("target")).toBe("_blank");
    expect(ticketsLink?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(ticketsLink?.getAttribute("aria-label")).toBe("Open Tickets in a new tab");
  });

  it("renders mobile Tickets as an external support link inside More", () => {
    const node = renderNode(<MobileNav />);
    openMore(node);

    const ticketsLink = findLink(node, "Tickets");
    expect(ticketsLink?.getAttribute("href")).toBe("https://support-hub-production.up.railway.app/");
    expect(ticketsLink?.getAttribute("target")).toBe("_blank");
    expect(ticketsLink?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(ticketsLink?.getAttribute("aria-label")).toBe("Open Tickets in a new tab");
  });

  it("keeps the rep mobile Commissions link reachable from More alongside Tickets", () => {
    authMock.user.role = "rep";
    const node = renderNode(<MobileNav />);
    openMore(node);

    const commissionsLink = findLink(node, "Commissions");
    const ticketsLink = findLink(node, "Tickets");
    expect(commissionsLink?.getAttribute("href")).toBe("/commissions");
    expect(ticketsLink?.getAttribute("href")).toBe("https://support-hub-production.up.railway.app/");
  });
});

describe("mobile primary tabs", () => {
  it("exposes Deals and Leads as primary bottom-nav tabs for directors", () => {
    authMock.user.role = "director";
    const node = renderNode(<MobileNav />);

    const dealsTab = findLink(node, "Deals Dashboard");
    const leadsTab = findLink(node, "Leads");
    expect(dealsTab?.getAttribute("href")).toBe("/deals");
    expect(leadsTab?.getAttribute("href")).toBe("/leads");
  });

  it("exposes Deals and Leads as primary bottom-nav tabs for reps", () => {
    authMock.user.role = "rep";
    const node = renderNode(<MobileNav />);

    const dealsTab = findLink(node, "Deals Dashboard");
    const leadsTab = findLink(node, "Leads");
    expect(dealsTab?.getAttribute("href")).toBe("/deals");
    expect(leadsTab?.getAttribute("href")).toBe("/leads");
  });

  it("toggles the More panel and only role-appropriate items appear", () => {
    authMock.user.role = "rep";
    const node = renderNode(<MobileNav />);

    // Closed by default: rep-only Commissions and the director surfaces are hidden.
    expect(findLink(node, "Commissions")).toBeUndefined();

    openMore(node);

    // Rep sees Commissions but never the director-only surfaces.
    expect(findLink(node, "Commissions")?.getAttribute("href")).toBe("/commissions");
    expect(findLink(node, "Team Commissions")).toBeUndefined();
    expect(findLink(node, "Director")).toBeUndefined();
  });

  it("shows directors their Director surfaces in More but not the rep Commissions page", () => {
    authMock.user.role = "director";
    const node = renderNode(<MobileNav />);
    openMore(node);

    expect(findLink(node, "Director")?.getAttribute("href")).toBe("/director");
    expect(findLink(node, "Team Commissions")?.getAttribute("href")).toBe("/director/commissions");
    // The rep-only personal commissions page must not leak to directors.
    expect(findLink(node, "Commissions")).toBeUndefined();
  });

  it("gates the mobile nav to the sidebar's role groups for a construction user", () => {
    authMock.user.role = "construction";
    const node = renderNode(<MobileNav />);

    // No CRM primary tabs for a field-only role.
    expect(findLink(node, "Deals Dashboard")).toBeUndefined();
    expect(findLink(node, "Leads")).toBeUndefined();
    expect(findLink(node, "Pipeline")).toBeUndefined();

    openMore(node);

    // Only the field surfaces the sidebar grants construction.
    expect(findLink(node, "Capture")?.getAttribute("href")).toBe("https://trockcam.com");
    expect(findLink(node, "Feed")?.getAttribute("href")).toBe("/photos/feed");
    expect(findLink(node, "Tickets")?.getAttribute("href")).toBe("https://support-hub-production.up.railway.app/");
    expect(findLink(node, "Contacts")).toBeUndefined();
    expect(findLink(node, "Reports")).toBeUndefined();
  });
});
