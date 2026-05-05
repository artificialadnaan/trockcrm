/**
 * @vitest-environment jsdom
 */
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomePage } from "./HomePage";

const authMock = vi.hoisted(() => ({
  user: { firstName: "Field", email: "field@example.com" },
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => authMock,
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
});

describe("HomePage", () => {
  it("renders the placeholder home screen", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    root.render(<HomePage />);

    await vi.waitFor(() => expect(container!.textContent).toContain("Welcome, Field."));
    expect(container.textContent).toContain("Project list is live.");
  });
});
