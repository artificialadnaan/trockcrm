// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizePipelineScope, useNormalizedStageRoute, type PipelineRole } from "./pipeline-scope";

const mocks = vi.hoisted(() => ({
  useAuthMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: mocks.useAuthMock,
}));

function StageRouteProbe({ role, path }: { role: PipelineRole; path: string }) {
  mocks.useAuthMock.mockReturnValue({
    user: { id: "user-1", role },
  });
  const route = useNormalizedStageRoute("deals", "stage-1");

  return createElement(
    "pre",
    { "data-testid": "route" },
    JSON.stringify({
        needsRedirect: route.needsRedirect,
        redirectTo: route.redirectTo,
        backTo: route.backTo,
        scope: route.query.scope,
        path,
      })
  );
}

function renderStageRoute(role: PipelineRole, path: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = null;

  act(() => {
    root = createRoot(container);
    root.render(createElement(MemoryRouter, { initialEntries: [path] }, createElement(StageRouteProbe, { role, path })));
  });

  const route = JSON.parse(container.querySelector("pre")?.textContent ?? "{}") as {
    needsRedirect: boolean;
    redirectTo: string;
    backTo: string;
    scope: string;
  };

  return {
    route,
    cleanup() {
      act(() => root?.unmount());
      container.remove();
    },
  };
}

describe("useNormalizedStageRoute", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = "";
    mocks.useAuthMock.mockReset();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("honors explicit scope=all in URL for director", () => {
    const { route, cleanup } = renderStageRoute("director", "/deals/stages/stage-1?scope=all");
    expect(route.scope).toBe("all");
    expect(route.needsRedirect).toBe(false);
    expect(route.backTo).toBe("/deals?scope=all");
    cleanup();
  });

  it("applies role-default when URL has no scope param", () => {
    const { route, cleanup } = renderStageRoute("director", "/deals/stages/stage-1");
    expect(route.scope).toBe("team");
    expect(route.needsRedirect).toBe(true);
    expect(route.redirectTo).toBe("/deals/stages/stage-1?scope=team");
    cleanup();
  });

  it("forces reps to mine even when URL says scope=all", () => {
    const { route, cleanup } = renderStageRoute("rep", "/deals/stages/stage-1?scope=all");
    expect(route.scope).toBe("mine");
    expect(route.needsRedirect).toBe(true);
    expect(route.redirectTo).toBe("/deals/stages/stage-1?scope=mine");
    cleanup();
  });

  it("applies role-default for admin when URL has no scope", () => {
    const { route, cleanup } = renderStageRoute("admin", "/deals/stages/stage-1");
    expect(route.scope).toBe("all");
    expect(route.needsRedirect).toBe(true);
    expect(route.redirectTo).toBe("/deals/stages/stage-1?scope=all");
    cleanup();
  });
});

describe("normalizePipelineScope", () => {
  it("redirects reps to mine scope when team is requested", () => {
    expect(
      normalizePipelineScope({
        role: "rep",
        requestedScope: "team",
        entity: "deals",
      })
    ).toEqual({
      allowedScope: "mine",
      redirectTo: "/deals?scope=mine",
    });
  });

  it("keeps directors on team scope when no scope is provided", () => {
    expect(
      normalizePipelineScope({
        role: "director",
        requestedScope: null,
        entity: "leads",
      })
    ).toEqual({
      allowedScope: "team",
      redirectTo: "/leads?scope=team",
    });
  });
});
