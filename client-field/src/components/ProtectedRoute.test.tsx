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

  it.each(["field_contractor", "admin", "director", "rep", "construction"] as const)(
    "renders for allowed %s users",
    async (role) => {
      authMock.user = { role };
      const node = renderProtected();
      await vi.waitFor(() => expect(node.textContent).toContain("Protected Home"));
    }
  );

  it("logs out unsupported roles", async () => {
    authMock.user = { role: "sales_manager" };
    const node = renderProtected();
    await vi.waitFor(() => expect(node.textContent).toContain("Login"));
    expect(authMock.logout).toHaveBeenCalled();
  });
});
