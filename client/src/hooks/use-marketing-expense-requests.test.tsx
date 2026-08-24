/**
 * @vitest-environment jsdom
 *
 * These hooks have to re-read when the TENANT SCOPE changes.
 *
 * `?officeId` is what `api()` turns into the `x-office-id` header, and that header is what picks the
 * schema. It is read from the URL at request time, not at render time — so a hook whose effect does not
 * depend on the office keeps showing the previous office's rows after a switch, while every action fired
 * from those rows is sent to the NEW tenant. Stale ids, new schema.
 *
 * Not hypothetical for this feature: the approver email links to
 * `/admin/marketing-expense-requests?officeId=…` and the confirmation to `/marketing-expense-requests?officeId=…`,
 * so arriving here with an office scope in the URL is the ordinary path, not an edge case.
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useMarketingExpenseQueue,
  useMyMarketingExpenseRequests,
} from "./use-marketing-expense-requests";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  api.mockResolvedValue({ requests: [] });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

/**
 * Renders a hook under a router and hands the test a real `navigate`.
 *
 * Re-rendering a fresh <MemoryRouter initialEntries> does NOT work: React reconciles it as the same
 * component and `initialEntries` is only read on first mount, so the URL never changes and the test passes
 * against a hook that ignores the office entirely. Driving `useNavigate` is an actual in-app office switch.
 */
let navigateTo: (url: string) => void = () => {};

function Harness({ useHook }: { useHook: () => unknown }) {
  const navigate = useNavigate();
  navigateTo = (url: string) => navigate(url);
  useHook();
  return null;
}

async function renderAt(url: string, useHook: () => unknown) {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="*" element={<Harness useHook={useHook} />} />
        </Routes>
      </MemoryRouter>,
    );
  });
}

async function switchOfficeTo(url: string) {
  await act(async () => {
    navigateTo(url);
  });
}

describe("useMyMarketingExpenseRequests", () => {
  it("loads once on mount", async () => {
    await renderAt("/marketing-expense-requests", useMyMarketingExpenseRequests);
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith("/marketing-expense-requests/mine");
  });

  it("RE-READS when only ?officeId changes", async () => {
    await renderAt("/marketing-expense-requests?officeId=office-a", useMyMarketingExpenseRequests);
    expect(api).toHaveBeenCalledTimes(1);

    await switchOfficeTo("/marketing-expense-requests?officeId=office-b");
    expect(api).toHaveBeenCalledTimes(2);
  });
});

describe("useMarketingExpenseQueue", () => {
  const queueAtPending = () => useMarketingExpenseQueue("pending");

  it("loads once on mount", async () => {
    await renderAt("/admin/marketing-expense-requests", queueAtPending);
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith("/marketing-expense-requests?status=pending");
  });

  it("RE-READS when only ?officeId changes", async () => {
    await renderAt("/admin/marketing-expense-requests?officeId=office-a", queueAtPending);
    expect(api).toHaveBeenCalledTimes(1);

    await switchOfficeTo("/admin/marketing-expense-requests?officeId=office-b");
    expect(api).toHaveBeenCalledTimes(2);
  });
});
