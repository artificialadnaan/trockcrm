// @vitest-environment jsdom
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

// Capture every API path the hook requests. api is the only external dependency of useFiles.
const { apiMock } = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  apiMock: vi.fn(async (_path: string) => ({ files: [], pagination: { page: 1, limit: 25, total: 0, totalPages: 0 } })),
}));
vi.mock("@/lib/api", () => ({ api: apiMock, resolveApiBase: () => "/api" }));

import { useFiles } from "./use-files";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
  apiMock.mockClear();
});

function Probe() {
  useFiles({
    dealId: "d1",
    dateFrom: "2026-07-01",
    dateTo: "2026-07-10",
    sortBy: "file_type",
    sortDir: "asc",
    fileKind: "documents",
    category: "contract",
  });
  return null;
}

function mountProbe() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(<Probe />);
}

describe("useFiles query string", () => {
  it("threads dateFrom/dateTo/sortBy/fileKind/category into the /files request", async () => {
    mountProbe();
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalled());
    const path = apiMock.mock.calls.map((c) => c[0] as string).find((p) => p.startsWith("/files"))!;
    expect(path).toContain("dealId=d1");
    expect(path).toContain("dateFrom=2026-07-01");
    expect(path).toContain("dateTo=2026-07-10");
    expect(path).toContain("sortBy=file_type");
    expect(path).toContain("sortDir=asc");
    expect(path).toContain("fileKind=documents");
    expect(path).toContain("category=contract");
  });
});
