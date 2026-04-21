import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { MyCleanupPage } from "./my-cleanup-page";

const mocks = vi.hoisted(() => ({
  useMyCleanupQueueMock: vi.fn(),
}));

vi.mock("@/hooks/use-ownership-cleanup", () => ({
  useMyCleanupQueue: mocks.useMyCleanupQueueMock,
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

function renderRoute() {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/pipeline/my-cleanup"]}>
      <Routes>
        <Route path="/pipeline/my-cleanup" element={<MyCleanupPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("MyCleanupPage route", () => {
  beforeEach(() => {
    mocks.useMyCleanupQueueMock.mockReturnValue({
      rows: [],
      total: 0,
      loading: true,
      error: null,
      refetch: vi.fn(),
    });
  });

  it("renders the route shell at /pipeline/my-cleanup", () => {
    const html = renderRoute();

    expect(html).toContain("My Cleanup");
    expect(html).toContain("Loading cleanup queue...");
  });
});
