/**
 * @vitest-environment jsdom
 */
import React, { useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => vi.fn());

vi.mock("./api", () => ({
  api: apiMock,
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

const { AuthProvider, useAuth } = await import("./auth");

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
  apiMock.mockReset();
});

function renderProbe(onReady?: (auth: ReturnType<typeof useAuth>) => void) {
  function Probe() {
    const auth = useAuth();
    useEffect(() => {
      onReady?.(auth);
    }, [auth]);
    return <div>{auth.loading ? "loading" : auth.user?.email ?? "signed out"}</div>;
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(<AuthProvider><Probe /></AuthProvider>);
  return container;
}

describe("field AuthProvider", () => {
  it("hydrates from /field/me and exposes login/logout", async () => {
    apiMock.mockResolvedValueOnce({
      user: {
        id: "field-1",
        email: "field@example.com",
        firstName: "Field",
        lastName: "User",
        role: "field_contractor",
        tenantId: "office-1",
        active: true,
      },
    });
    let latest: ReturnType<typeof useAuth> | undefined;
    const node = renderProbe((auth) => {
      latest = auth;
    });

    await vi.waitFor(() => expect(node.textContent).toContain("field@example.com"));
    expect(apiMock).toHaveBeenCalledWith("/field/me");

    apiMock.mockResolvedValueOnce({
      user: {
        id: "field-1",
        email: "login@example.com",
        firstName: "Login",
        lastName: "User",
        role: "field_contractor",
        tenantId: "office-1",
        active: true,
      },
    });
    await latest!.login("login@example.com", "password-123");
    expect(apiMock).toHaveBeenCalledWith("/auth/field-login", {
      method: "POST",
      json: { email: "login@example.com", password: "password-123" },
    });

    apiMock.mockResolvedValueOnce({ success: true });
    await latest!.logout();
    await vi.waitFor(() => expect(node.textContent).toContain("signed out"));
  });

  it("clears state on 401 hydrate failures", async () => {
    apiMock.mockRejectedValueOnce(Object.assign(new Error("auth required"), { status: 401 }));
    const node = renderProbe();
    await vi.waitFor(() => expect(node.textContent).toContain("signed out"));
  });

  it("reports malformed server user payloads separately from authorization failures", async () => {
    apiMock.mockResolvedValueOnce({
      user: {
        id: "field-1",
        email: "field@example.com",
        displayName: "Field User",
        role: "field_contractor",
        officeId: "office-1",
      },
    });
    let latest: ReturnType<typeof useAuth> | undefined;
    const node = renderProbe((auth) => {
      latest = auth;
    });

    await vi.waitFor(() => expect(node.textContent).toContain("signed out"));
    expect(latest?.error).toBe("Server returned malformed user data");
  });
});
