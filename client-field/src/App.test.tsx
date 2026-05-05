/**
 * @vitest-environment jsdom
 */
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({
  api: apiMock,
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

const { App } = await import("./App");

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
  apiMock.mockReset();
});

describe("App", () => {
  it("renders the login route after unauthenticated hydration", async () => {
    apiMock.mockRejectedValueOnce(Object.assign(new Error("Authentication required"), { status: 401 }));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    root.render(<MemoryRouter initialEntries={["/"]}><App /></MemoryRouter>);

    await vi.waitFor(() => expect(container!.textContent).toContain("Field App"));
  });
});
