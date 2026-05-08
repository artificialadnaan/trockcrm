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
  const { user, loading, localLogin } = useAuth();
  const [result, setResult] = React.useState<Record<string, unknown> | null>(null);

  return (
    <div>
      <div data-testid="loading">{String(loading)}</div>
      <div data-testid="user-state">{user ? `${user.email}:${String(user.mustChangePassword)}` : "none"}</div>
      <div data-testid="result">{result ? JSON.stringify(result) : "none"}</div>
      <button
        type="button"
        onClick={async () => {
          const loginResult = await localLogin("rep@example.com", "temporary", "https://onboarding.trockcrm.com/cleanup");
          setResult(loginResult as Record<string, unknown>);
        }}
      >
        login
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
});
