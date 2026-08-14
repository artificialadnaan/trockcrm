/**
 * @vitest-environment jsdom
 */
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

vi.mock("./lib/auth", () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAuth: () => ({
    user: {
      id: "field-1",
      email: "field@example.com",
      firstName: "Field",
      lastName: "User",
      role: "field_contractor",
      tenantId: "office-1",
      active: true,
    },
    loading: false,
    logout: vi.fn(),
  }),
}));

vi.mock("./components/ProtectedRoute", () => ({
  ProtectedRoute: () => <div>Protected shell</div>,
}));

vi.mock("./pages/LoginPage", () => ({ LoginPage: () => <div>Login page</div> }));
vi.mock("./pages/AcceptInvitePage", () => ({ AcceptInvitePage: () => <div>Accept invite</div> }));
vi.mock("./pages/CapturePage", () => ({ CapturePage: () => <div>Capture page</div> }));
vi.mock("./pages/HomePage", () => ({ HomePage: () => <div>Home page</div> }));
vi.mock("./pages/ProjectDetailPage", () => ({ ProjectDetailPage: () => <div>Project detail</div> }));
vi.mock("./pages/ProjectsPage", () => ({ ProjectsPage: () => <div>Projects page</div> }));
vi.mock("./pages/ResetPasswordPage", () => ({ ResetPasswordPage: () => <div>Reset password page</div> }));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
});

describe("App routes", () => {
  it("registers the field capture route", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    root.render(
      <MemoryRouter initialEntries={["/capture"]}>
        <App />
      </MemoryRouter>
    );

    await vi.waitFor(() => expect(container!.textContent).toContain("Protected shell"));
  });

  it("registers the public password reset route", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    root.render(
      <MemoryRouter initialEntries={["/reset-password?token=raw-token"]}>
        <App />
      </MemoryRouter>,
    );

    await vi.waitFor(() => expect(container!.textContent).toContain("Reset password page"));
  });
});
