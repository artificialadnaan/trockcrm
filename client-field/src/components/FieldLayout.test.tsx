/**
 * @vitest-environment jsdom
 */
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FieldLayout } from "./FieldLayout";

const authMock = vi.hoisted(() => ({
  user: { firstName: "Field", lastName: "User", email: "field@example.com" },
  logout: vi.fn(),
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
  authMock.logout.mockReset();
});

describe("FieldLayout", () => {
  it("renders header, bottom navigation, child route, and logout", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={["/projects"]}>
        <Routes>
          <Route element={<FieldLayout />}>
            <Route path="/projects" element={<div>Projects content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    );

    await vi.waitFor(() => expect(container!.textContent).toContain("Field User"));
    expect(container.textContent).toContain("Projects");
    expect(container.textContent).toContain("Capture");
    expect(container.textContent).toContain("Profile");
    expect(container.textContent).toContain("Projects content");

    container.querySelector<HTMLButtonElement>('[aria-label="Log out"]')?.click();
    expect(authMock.logout).toHaveBeenCalled();
  });
});
