// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizePipelineScope, useNormalizedStageRoute, type PipelineEntity, type PipelineRole } from "./pipeline-scope";

const mocks = vi.hoisted(() => ({
  useAuthMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: mocks.useAuthMock,
}));

function StageRouteProbe({ entity, role, path }: { entity: PipelineEntity; role: PipelineRole; path: string }) {
  mocks.useAuthMock.mockReturnValue({
    user: { id: "user-1", role },
  });
  const route = useNormalizedStageRoute(entity, "stage-1");

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

function renderStageRoute(role: PipelineRole, path: string, entity: PipelineEntity = "deals") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = null;

  act(() => {
    root = createRoot(container);
    root.render(createElement(MemoryRouter, { initialEntries: [path] }, createElement(StageRouteProbe, { entity, role, path })));
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

  it.each([
    ["rep", "all", "mine", true, "/deals/stages/stage-1?scope=mine"],
    ["rep", "team", "mine", true, "/deals/stages/stage-1?scope=mine"],
    ["director", "all", "all", false, "/deals/stages/stage-1?scope=all"],
    ["director", "team", "team", false, "/deals/stages/stage-1?scope=team"],
    ["director", "mine", "mine", false, "/deals/stages/stage-1?scope=mine"],
    ["admin", "all", "all", false, "/deals/stages/stage-1?scope=all"],
    ["admin", "team", "team", false, "/deals/stages/stage-1?scope=team"],
    ["admin", "mine", "mine", false, "/deals/stages/stage-1?scope=mine"],
  ] as const)("resolves /deals explicit scope for %s scope=%s", (role, requestedScope, expectedScope, needsRedirect, redirectTo) => {
    const { route, cleanup } = renderStageRoute(role, `/deals/stages/stage-1?scope=${requestedScope}`, "deals");
    expect(route.scope).toBe(expectedScope);
    expect(route.needsRedirect).toBe(needsRedirect);
    expect(route.redirectTo).toBe(redirectTo);
    cleanup();
  });

  it.each([
    ["rep", "all", "mine", true, "/leads/stages/stage-1?scope=mine"],
    ["rep", "team", "mine", true, "/leads/stages/stage-1?scope=mine"],
    ["director", "all", "all", false, "/leads/stages/stage-1?scope=all"],
    ["director", "team", "team", false, "/leads/stages/stage-1?scope=team"],
    ["director", "mine", "mine", false, "/leads/stages/stage-1?scope=mine"],
    ["admin", "all", "all", false, "/leads/stages/stage-1?scope=all"],
    ["admin", "team", "team", false, "/leads/stages/stage-1?scope=team"],
    ["admin", "mine", "mine", false, "/leads/stages/stage-1?scope=mine"],
  ] as const)("resolves /leads explicit scope for %s scope=%s", (role, requestedScope, expectedScope, needsRedirect, redirectTo) => {
    const { route, cleanup } = renderStageRoute(role, `/leads/stages/stage-1?scope=${requestedScope}`, "leads");
    expect(route.scope).toBe(expectedScope);
    expect(route.needsRedirect).toBe(needsRedirect);
    expect(route.redirectTo).toBe(redirectTo);
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

  it("preserves explicit all scope for directors", () => {
    expect(
      normalizePipelineScope({
        role: "director",
        requestedScope: "all",
        entity: "deals",
      })
    ).toEqual({
      allowedScope: "all",
      redirectTo: "/deals?scope=all",
    });
  });

  it("preserves explicit team scope for admins", () => {
    expect(
      normalizePipelineScope({
        role: "admin",
        requestedScope: "team",
        entity: "leads",
      })
    ).toEqual({
      allowedScope: "team",
      redirectTo: "/leads?scope=team",
    });
  });
});
