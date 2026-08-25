/**
 * @vitest-environment jsdom
 */
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./auth";
import { api } from "./api";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("./api", () => ({
  api: vi.fn(),
}));

const mockedApi = vi.mocked(api);

let container: HTMLDivElement;
let root: Root;

function Probe() {
  const {
    user,
    loading,
    localLogin,
    login,
    changePassword,
    refreshUser,
    assignmentModalSession,
    assignmentModalSessionResetPending,
  } = useAuth();
  const [result, setResult] = React.useState<Record<string, unknown> | null>(null);

  return (
    <div>
      <div data-testid="loading">{String(loading)}</div>
      <div data-testid="user-state">{user ? `${user.email}:${String(user.mustChangePassword)}` : "none"}</div>
      <div data-testid="result">{result ? JSON.stringify(result) : "none"}</div>
      <div data-testid="assignment-modal-session">
        {`${assignmentModalSession}:${String(assignmentModalSessionResetPending)}`}
      </div>
      <button
        data-testid="local-login"
        type="button"
        onClick={async () => {
          const loginResult = await localLogin("rep@example.com", "temporary", "https://onboarding.trockcrm.com/cleanup");
          setResult(loginResult as Record<string, unknown>);
        }}
      >
        login
      </button>
      <button
        data-testid="dev-login"
        type="button"
        onClick={async () => {
          await login("rep@trock.dev");
        }}
      >
        dev login
      </button>
      <button
        data-testid="change-password"
        type="button"
        onClick={async () => {
          await changePassword("temporary", "new-password");
        }}
      >
        change password
      </button>
      <button
        data-testid="refresh-user"
        type="button"
        onClick={async () => {
          await refreshUser();
        }}
      >
        refresh user
      </button>
    </div>
  );
}

beforeEach(() => {
  mockedApi.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe("AuthProvider local login", () => {
  it("keeps must-change-password users in app state instead of immediately honoring returnTo", async () => {
    mockedApi.mockImplementation(async (path) => {
      if (path === "/auth/me") throw new Error("not signed in");
      if (path === "/auth/local/login") {
        return {
          user: {
            id: "user-1",
            email: "rep@example.com",
            displayName: "Rep Example",
            role: "rep",
            officeId: "office-1",
            mustChangePassword: true,
            requiresOnboarding: true,
          },
          returnTo: "https://onboarding.trockcrm.com/cleanup",
        };
      }
      throw new Error(`Unexpected API call: ${path}`);
    });

    await act(async () => {
      root.render(
        <AuthProvider>
          <Probe />
        </AuthProvider>,
      );
    });

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    await act(async () => {
      container.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(container.querySelector('[data-testid="user-state"]')?.textContent).toBe("rep@example.com:true");
    expect(container.querySelector('[data-testid="result"]')?.textContent).toContain('"mustChangePassword":true');
    expect(container.querySelector('[data-testid="result"]')?.textContent).toContain('"returnTo":"https://onboarding.trockcrm.com/cleanup"');
  });

  it("starts a fresh assignment-modal session only after explicit web auth", async () => {
    const user = {
      id: "user-1",
      email: "rep@example.com",
      displayName: "Rep Example",
      role: "rep" as const,
      officeId: "office-1",
      mustChangePassword: false,
    };
    mockedApi.mockImplementation(async (path) => {
      if (path === "/auth/me") return { user };
      if (path === "/auth/dev/login") return { user: { ...user, email: "rep@trock.dev" } };
      if (path === "/auth/local/login") return { user };
      if (path === "/auth/local/change-password") return { user };
      throw new Error(`Unexpected API call: ${path}`);
    });

    await act(async () => {
      root.render(
        <AuthProvider>
          <Probe />
        </AuthProvider>,
      );
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    const session = () => container.querySelector('[data-testid="assignment-modal-session"]')?.textContent;
    const click = async (testId: string) => {
      await act(async () => {
        container.querySelector(`[data-testid="${testId}"]`)?.dispatchEvent(
          new MouseEvent("click", { bubbles: true }),
        );
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    };

    // Boot and a /auth/me refresh restore the cookie-backed login. They must preserve the shown-set
    // that makes F5 quiet, rather than manufacturing a new session for the modal.
    expect(session()).toBe("0:false");
    await click("refresh-user");
    expect(session()).toBe("0:false");

    await click("dev-login");
    expect(session()).toBe("1:true");
    await click("refresh-user");
    expect(session()).toBe("1:true");

    await click("local-login");
    expect(session()).toBe("2:true");
    await click("change-password");
    expect(session()).toBe("3:true");
  });
});
