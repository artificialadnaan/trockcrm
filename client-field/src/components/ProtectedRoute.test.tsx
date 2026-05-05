/**
 * @vitest-environment jsdom
 */
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProtectedRoute } from "./ProtectedRoute";

const authMock = vi.hoisted(() => ({
  loading: false,
  user: null as any,
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
  authMock.loading = false;
  authMock.user = null;
  authMock.logout.mockReset();
});

function renderProtected() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(
    <MemoryRouter initialEntries={["/home"]}>
      <Routes>
        <Route path="/" element={<div>Login</div>} />
        <Route element={<ProtectedRoute />}>
          <Route path="/home" element={<div>Protected Home</div>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
  return container;
}

describe("ProtectedRoute", () => {
  it("redirects unauthenticated users to login", async () => {
    const node = renderProtected();
    await vi.waitFor(() => expect(node.textContent).toContain("Login"));
  });

  it("renders for field contractors and logs out wrong roles", async () => {
    authMock.user = { role: "field_contractor" };
    const node = renderProtected();
    await vi.waitFor(() => expect(node.textContent).toContain("Protected Home"));

    root?.unmount();
    authMock.user = { role: "admin" };
    root = createRoot(container!);
    root.render(
      <MemoryRouter initialEntries={["/home"]}>
        <Routes>
          <Route path="/" element={<div>Login</div>} />
          <Route element={<ProtectedRoute />}>
            <Route path="/home" element={<div>Protected Home</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    );
    await vi.waitFor(() => expect(authMock.logout).toHaveBeenCalled());
  });
});
