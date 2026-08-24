/**
 * @vitest-environment jsdom
 *
 * BOTH navs, for every role, by RENDERING them.
 *
 * The two files gate independently and have drifted before: `sidebar.tsx` groups admin items and
 * `mobile-nav.tsx` has no group concept at all, and its `CRM_ROLES` constant is a DIFFERENT set from the
 * roles the sidebar enumerates. A page added to one and forgotten in the other is reachable on a laptop and
 * invisible on a phone — with nothing failing to say so, because neither file imports the other.
 */
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./sidebar";
import { MobileNav } from "./mobile-nav";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Role = "admin" | "director" | "sales_manager" | "rep" | "construction";

const authMock = vi.hoisted(() => ({
  user: {
    id: "user-1",
    displayName: "A User",
    email: "user@example.com",
    role: "admin" as Role,
    officeId: "office-1",
    activeOfficeId: "office-1",
  },
  logout: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ useAuth: () => authMock }));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  authMock.user.role = "admin";
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

function renderFor(role: Role, node: React.ReactElement) {
  authMock.user.role = role;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<MemoryRouter>{node}</MemoryRouter>);
  });
  return container;
}

function hrefs(node: HTMLElement) {
  return Array.from(node.querySelectorAll("a")).map((anchor) => anchor.getAttribute("href"));
}

function openMore(node: HTMLElement) {
  const moreButton = node.querySelector<HTMLButtonElement>("button[aria-label='More navigation']");
  if (moreButton) act(() => moreButton.click());
  return node;
}

const SUBMIT_PATH = "/marketing-expense-requests";
const QUEUE_PATH = "/admin/marketing-expense-requests";

// The roles that can actually exist. `sales_manager` is in both nav files' local Role unions and in
// NEITHER `USER_ROLES` nor `CRM_ASSIGNABLE_ROLES` — no account can hold it, and it appears in zero nav
// entries in either file today. It stays excluded rather than becoming this page's sole special case.
const SUBMIT_ROLES: Role[] = ["admin", "director", "rep", "construction"];

describe("sidebar", () => {
  it.each(SUBMIT_ROLES)("gives a %s the submit + status entry in the main nav", (role) => {
    expect(hrefs(renderFor(role, <Sidebar />))).toContain(SUBMIT_PATH);
  });

  it("gives a sales_manager nothing, exactly as it gives them nothing else", () => {
    expect(hrefs(renderFor("sales_manager", <Sidebar />))).not.toContain(SUBMIT_PATH);
  });

  it.each(["admin", "director"] as Role[])("gives a %s the approver queue under Operations", (role) => {
    expect(hrefs(renderFor(role, <Sidebar />))).toContain(QUEUE_PATH);
  });

  it.each(["rep", "construction"] as Role[])("keeps the approver queue away from a %s", (role) => {
    expect(hrefs(renderFor(role, <Sidebar />))).not.toContain(QUEUE_PATH);
  });
});

describe("mobile nav", () => {
  it.each(SUBMIT_ROLES)("gives a %s the same submit + status entry", (role) => {
    expect(hrefs(openMore(renderFor(role, <MobileNav />)))).toContain(SUBMIT_PATH);
  });

  it("gives a sales_manager nothing — its bar does not render at all for that role", () => {
    expect(hrefs(openMore(renderFor("sales_manager", <MobileNav />)))).not.toContain(SUBMIT_PATH);
  });

  it.each(["admin", "director"] as Role[])("gives a %s the approver queue, flat (it has no admin groups)", (role) => {
    expect(hrefs(openMore(renderFor(role, <MobileNav />)))).toContain(QUEUE_PATH);
  });

  it.each(["rep", "construction"] as Role[])("keeps the approver queue away from a %s", (role) => {
    expect(hrefs(openMore(renderFor(role, <MobileNav />)))).not.toContain(QUEUE_PATH);
  });
});

describe("the two navs agree", () => {
  it.each(["admin", "director", "rep", "construction", "sales_manager"] as Role[])(
    "reaches the same marketing-expense destinations for a %s",
    (role) => {
      const desktop = hrefs(renderFor(role, <Sidebar />)).filter((href) =>
        href?.includes("marketing-expense"),
      );
      act(() => root?.unmount());
      container?.remove();

      const mobile = hrefs(openMore(renderFor(role, <MobileNav />))).filter((href) =>
        href?.includes("marketing-expense"),
      );
      expect([...mobile].sort()).toEqual([...desktop].sort());
    },
  );
});
