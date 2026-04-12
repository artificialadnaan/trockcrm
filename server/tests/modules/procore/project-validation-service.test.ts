import { beforeEach, describe, expect, it, vi } from "vitest";
import { listCompanyProjectsPage } from "../../../src/lib/procore-client.js";
import { AppError } from "../../../src/middleware/error-handler.js";
import { listProjectValidation } from "../../../src/modules/procore/project-validation-service.js";

const projectValidationServiceMocks = vi.hoisted(() => ({
  listProjectValidationForOffice: vi.fn(),
}));

vi.mock("../../../src/modules/procore/project-validation-service.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/modules/procore/project-validation-service.js")
  >("../../../src/modules/procore/project-validation-service.js");

  return {
    ...actual,
    listProjectValidationForOffice: projectValidationServiceMocks.listProjectValidationForOffice,
  };
});

const { procoreRoutes } = await import("../../../src/modules/procore/routes.js");
const { listProjectValidationForOffice } = await vi.importActual<
  typeof import("../../../src/modules/procore/project-validation-service.js")
>("../../../src/modules/procore/project-validation-service.js");

function makeProject(overrides: Partial<{
  id: number;
  name: string;
  projectNumber: string | null;
  city: string | null;
  state: string | null;
  address: string | null;
  updatedAt: string | null;
}> = {}) {
  return {
    id: 1,
    name: "Alpha Tower",
    projectNumber: "TR-001",
    city: "Dallas",
    state: "TX",
    address: "100 Main St",
    updatedAt: "2026-04-12T00:00:00.000Z",
    ...overrides,
  };
}

function makeDeal(overrides: Partial<{
  id: string;
  dealNumber: string | null;
  name: string;
  city: string | null;
  state: string | null;
  address: string | null;
  procoreProjectId: number | null;
  updatedAt: string | null;
}> = {}) {
  return {
    id: "deal-1",
    dealNumber: "TR-001",
    name: "Alpha Tower",
    city: "Dallas",
    state: "TX",
    address: "100 Main St",
    procoreProjectId: null,
    updatedAt: "2026-04-12T00:00:00.000Z",
    ...overrides,
  };
}

type TestUser = {
  id: string;
  role: "admin" | "director" | "rep";
  displayName: string;
  email: string;
  officeId: string;
  activeOfficeId: string;
};

function makeResponse() {
  return {
    statusCode: 200,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
  };
}

function findRouteStack(method: "get", routePath: string) {
  const layer = (procoreRoutes as any).stack.find(
    (entry: any) => entry.route?.path === routePath && entry.route?.methods?.[method]
  );

  if (!layer) {
    throw new Error(`Route not found: ${method.toUpperCase()} ${routePath}`);
  }

  return layer.route.stack as Array<{
    handle: (req: any, res: any, next: (err?: unknown) => void) => unknown;
  }>;
}

async function invokeRoute({
  method,
  routePath,
  url,
  user,
}: {
  method: "get";
  routePath: string;
  url: string;
  user: TestUser;
}) {
  const stack = findRouteStack(method, routePath);
  const req = {
    method: method.toUpperCase(),
    url,
    originalUrl: `/api/procore${url}`,
    baseUrl: "/api/procore",
    path: url,
    params: {},
    query: {},
    body: {},
    user,
    tenantDb: {},
    commitTransaction: vi.fn().mockResolvedValue(undefined),
    headers: {},
  } as any;
  const res = makeResponse();

  let index = 0;
  const next = async (err?: unknown): Promise<void> => {
    if (err) throw err;
    const layer = stack[index++];
    if (!layer) return;
    let downstreamPromise: Promise<void> | undefined;
    const layerNext = (nextErr?: unknown) => {
      downstreamPromise = next(nextErr);
      return downstreamPromise;
    };

    await Promise.resolve(layer.handle(req, res, layerNext));
    await downstreamPromise;
  };

  await next();
  return { req, res };
}

function makeUser(role: TestUser["role"]): TestUser {
  return {
    id: `${role}-1`,
    role,
    displayName: `${role} user`,
    email: `${role}@example.com`,
    officeId: "office-1",
    activeOfficeId: "office-1",
  };
}

describe("project validation service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a linked exact match when deal.procoreProjectId matches project.id", async () => {
    const result = await listProjectValidation({
      companyId: "598134325683880",
      pageSize: 100,
      maxProjects: 100,
      listProjectsPage: vi.fn().mockResolvedValueOnce([makeProject({ id: 42 })]),
      listActiveDeals: vi.fn().mockResolvedValueOnce([makeDeal({ procoreProjectId: 42 })]),
    });

    expect(result.projects[0].status).toBe("matched");
    expect(result.projects[0].matchReason).toBe("procore_project_id");
    expect(result.projects[0].deal?.id).toBe("deal-1");
  });

  it("reports the validation result as read-only metadata", async () => {
    const now = new Date("2026-04-12T12:34:56.000Z");
    const result = await listProjectValidation({
      companyId: "598134325683880",
      pageSize: 100,
      maxProjects: 100,
      listProjectsPage: vi.fn().mockResolvedValueOnce([makeProject()]),
      listActiveDeals: vi.fn().mockResolvedValueOnce([]),
      now: () => now,
    });

    expect(result.meta.readOnly).toBe(true);
    expect(result.meta.fetchedAt).toBe(now.toISOString());
  });

  it("matches by normalized project number when no project-id link exists", async () => {
    const result = await listProjectValidation({
      companyId: "598134325683880",
      pageSize: 100,
      maxProjects: 100,
      listProjectsPage: vi.fn().mockResolvedValueOnce([makeProject({ id: 42, projectNumber: "TR-001" })]),
      listActiveDeals: vi.fn().mockResolvedValueOnce([
        makeDeal({
          id: "deal-number",
          procoreProjectId: null,
          dealNumber: "TR001",
          name: "Other Name",
          city: "Houston",
          state: "TX",
          address: "500 Elsewhere",
        }),
      ]),
    });

    expect(result.projects[0].status).toBe("matched");
    expect(result.projects[0].matchReason).toBe("project_number");
    expect(result.projects[0].deal?.id).toBe("deal-number");
  });

  it("ignores deals linked to a different project for fuzzy name-location matching", async () => {
    const result = await listProjectValidation({
      companyId: "598134325683880",
      pageSize: 100,
      maxProjects: 100,
      listProjectsPage: vi.fn().mockResolvedValueOnce([
        makeProject({
          id: 42,
          projectNumber: null,
          name: "Linked Elsewhere",
          city: "Austin",
          state: "TX",
          address: "500 River Rd",
        }),
      ]),
      listActiveDeals: vi.fn().mockResolvedValueOnce([
        makeDeal({
          id: "deal-foreign-link",
          procoreProjectId: 999,
          dealNumber: null,
          name: "Linked Elsewhere",
          city: "Austin",
          state: "TX",
          address: "500 River Rd",
        }),
      ]),
    });

    expect(result.projects[0].status).toBe("unmatched");
    expect(result.projects[0].matchReason).toBe("none");
    expect(result.projects[0].deal).toBeNull();
  });

  it("prefers procoreProjectId over project number and name-location tiers", async () => {
    const result = await listProjectValidation({
      companyId: "598134325683880",
      pageSize: 100,
      maxProjects: 100,
      listProjectsPage: vi.fn().mockResolvedValueOnce([makeProject({ id: 42, projectNumber: "TR-001" })]),
      listActiveDeals: vi.fn().mockResolvedValueOnce([
        makeDeal({
          id: "deal-id",
          procoreProjectId: 42,
          dealNumber: "OTHER-999",
          name: "Mismatch",
          city: "Austin",
          state: "TX",
          address: "500 River Rd",
        }),
        makeDeal({
          id: "deal-number",
          procoreProjectId: null,
          dealNumber: "TR-001",
        }),
        makeDeal({
          id: "deal-location",
          procoreProjectId: null,
        }),
      ]),
    });

    expect(result.projects[0].status).toBe("matched");
    expect(result.projects[0].matchReason).toBe("procore_project_id");
    expect(result.projects[0].deal?.id).toBe("deal-id");
  });

  it("prefers project number over name-location matches", async () => {
    const result = await listProjectValidation({
      companyId: "598134325683880",
      pageSize: 100,
      maxProjects: 100,
      listProjectsPage: vi.fn().mockResolvedValueOnce([makeProject({ id: 42, projectNumber: "TR-001" })]),
      listActiveDeals: vi.fn().mockResolvedValueOnce([
        makeDeal({
          id: "deal-number",
          procoreProjectId: null,
          dealNumber: "TR-001",
          name: "Other Name",
          city: "Austin",
          state: "TX",
          address: "500 River Rd",
        }),
        makeDeal({
          id: "deal-location",
          procoreProjectId: null,
          dealNumber: null,
        }),
      ]),
    });

    expect(result.projects[0].status).toBe("matched");
    expect(result.projects[0].matchReason).toBe("project_number");
    expect(result.projects[0].deal?.id).toBe("deal-number");
  });

  it("marks a project ambiguous when multiple deals tie on the best eligible match tier", async () => {
    const result = await listProjectValidation({
      companyId: "598134325683880",
      pageSize: 100,
      maxProjects: 100,
      listProjectsPage: vi.fn().mockResolvedValueOnce([
        makeProject({
          id: 99,
          name: "Legacy Plaza",
          projectNumber: null,
          city: "Fort Worth",
          state: "TX",
          address: "200 Elm St",
          updatedAt: null,
        }),
      ]),
      listActiveDeals: vi.fn().mockResolvedValueOnce([
        makeDeal({
          id: "deal-a",
          dealNumber: null,
          name: "Legacy Plaza",
          city: "Fort Worth",
          state: "TX",
          address: "200 Elm St",
          updatedAt: null,
        }),
        makeDeal({
          id: "deal-b",
          dealNumber: null,
          name: "Legacy Plaza",
          city: "Fort Worth",
          state: "TX",
          address: "200 Elm St",
          updatedAt: null,
        }),
      ]),
    });

    expect(result.projects[0].status).toBe("ambiguous");
    expect(result.projects[0].deal).toBeNull();
  });

  it("marks a project unmatched when no CRM deal clears the match thresholds", async () => {
    const result = await listProjectValidation({
      companyId: "598134325683880",
      pageSize: 100,
      maxProjects: 100,
      listProjectsPage: vi.fn().mockResolvedValueOnce([
        makeProject({
          id: 77,
          name: "Procore Only Job",
          projectNumber: "PC-777",
          city: "Austin",
          state: "TX",
          address: "500 River Rd",
          updatedAt: null,
        }),
      ]),
      listActiveDeals: vi.fn().mockResolvedValueOnce([]),
    });

    expect(result.projects[0].status).toBe("unmatched");
    expect(result.projects[0].deal).toBeNull();
  });

  it("sets meta.truncated when the project cap is hit", async () => {
    const result = await listProjectValidation({
      companyId: "598134325683880",
      pageSize: 2,
      maxProjects: 1,
      listProjectsPage: vi.fn().mockResolvedValueOnce([
        { id: 1, name: "One", projectNumber: null, city: null, state: null, address: null, updatedAt: null },
        { id: 2, name: "Two", projectNumber: null, city: null, state: null, address: null, updatedAt: null },
      ]),
      listActiveDeals: vi.fn().mockResolvedValueOnce([]),
    });

    expect(result.meta.truncated).toBe(true);
    expect(result.projects).toHaveLength(1);
  });

  it("pages across multiple requests until maxProjects is reached", async () => {
    const listProjectsPage = vi
      .fn()
      .mockResolvedValueOnce([makeProject({ id: 1 }), makeProject({ id: 2 })])
      .mockResolvedValueOnce([makeProject({ id: 3 }), makeProject({ id: 4 })]);

    const result = await listProjectValidation({
      companyId: "598134325683880",
      pageSize: 2,
      maxProjects: 3,
      listProjectsPage,
      listActiveDeals: vi.fn().mockResolvedValueOnce([]),
    });

    expect(listProjectsPage).toHaveBeenCalledTimes(2);
    expect(result.projects.map((row) => row.project.id)).toEqual([1, 2, 3]);
    expect(result.meta.fetchedCount).toBe(3);
    expect(result.meta.truncated).toBe(true);
  });

  it("marks truncation when maxProjects lands exactly on a full page and another page exists", async () => {
    const listProjectsPage = vi
      .fn()
      .mockResolvedValueOnce([makeProject({ id: 1 }), makeProject({ id: 2 })])
      .mockResolvedValueOnce([makeProject({ id: 3 })]);

    const result = await listProjectValidation({
      companyId: "598134325683880",
      pageSize: 2,
      maxProjects: 2,
      listProjectsPage,
      listActiveDeals: vi.fn().mockResolvedValueOnce([]),
    });

    expect(listProjectsPage).toHaveBeenCalledTimes(2);
    expect(result.projects.map((row) => row.project.id)).toEqual([1, 2]);
    expect(result.meta.truncated).toBe(true);
  });

  it("normalizes office deal updatedAt values to ISO strings", async () => {
    const rows = [
      {
        id: "deal-date",
        dealNumber: "TR-001",
        name: "Alpha Tower",
        city: "Dallas",
        state: "TX",
        address: "100 Main St",
        procoreProjectId: null,
        updatedAt: new Date("2026-04-12T10:00:00.000Z"),
      },
      {
        id: "deal-null",
        dealNumber: "TR-002",
        name: "Beta Tower",
        city: "Austin",
        state: "TX",
        address: "200 Main St",
        procoreProjectId: null,
        updatedAt: null,
      },
    ];

    const tenantDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(rows),
        }),
      }),
    } as any;

    const result = await listProjectValidationForOffice(tenantDb, {
      companyId: "598134325683880",
      pageSize: 100,
      maxProjects: 100,
      listProjectsPage: vi.fn().mockResolvedValueOnce([]),
    });

    expect(result.summary.totalDeals).toBe(2);
    expect(tenantDb.select).toHaveBeenCalledOnce();
  });
});

describe("project validation route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PROCORE_COMPANY_ID = "598134325683880";
  });

  it("requires admin role for project validation", async () => {
    const request = invokeRoute({
      method: "get",
      routePath: "/project-validation",
      url: "/project-validation",
      user: makeUser("rep"),
    });

    await expect(request).rejects.toMatchObject<AppError>({
      statusCode: 403,
      message: "Requires one of: admin",
    });
    expect(projectValidationServiceMocks.listProjectValidationForOffice).not.toHaveBeenCalled();
  });

  it("returns an explicit auth error instead of an empty validation result", async () => {
    projectValidationServiceMocks.listProjectValidationForOffice.mockRejectedValueOnce(
      new Error("PROCORE_OAUTH_REQUIRED")
    );

    const request = invokeRoute({
      method: "get",
      routePath: "/project-validation",
      url: "/project-validation",
      user: makeUser("admin"),
    });

    await expect(request).rejects.toMatchObject<AppError>({
      statusCode: 503,
      message: "Procore authentication required",
    });
  });

  it("returns an explicit auth error when oauth refresh fails", async () => {
    projectValidationServiceMocks.listProjectValidationForOffice.mockRejectedValueOnce(
      new Error("PROCORE_OAUTH_REFRESH_FAILED")
    );

    const request = invokeRoute({
      method: "get",
      routePath: "/project-validation",
      url: "/project-validation",
      user: makeUser("admin"),
    });

    await expect(request).rejects.toMatchObject<AppError>({
      statusCode: 503,
      message: "Procore authentication required",
    });
  });
});

describe("procore client read auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PROCORE_CLIENT_ID = "client-id";
    process.env.PROCORE_CLIENT_SECRET = "client-secret";
    process.env.PROCORE_COMPANY_ID = "598134325683880";
  });

  it("prefers stored oauth tokens over client credentials for read requests", async () => {
    const getStoredTokens = vi.fn().mockResolvedValue({
      accessToken: "oauth-token",
      refreshToken: "refresh-token",
      expiresAt: new Date(Date.now() + 120_000),
      scopes: ["read"],
      accountEmail: "admin@trock.dev",
      accountName: "Admin User",
      status: "active",
      lastError: null,
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));

    await listCompanyProjectsPage("598134325683880", 1, 5, {
      fetchImpl: fetchMock,
      getStoredTokens,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.headers?.Authorization).toBe("Bearer oauth-token");
    expect(fetchMock.mock.calls[0]?.[1]?.headers?.["Procore-Company-Id"]).toBe("598134325683880");
  });

  it("refreshes an expired stored oauth token before issuing the read request", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "refreshed-access",
            refresh_token: "refreshed-refresh",
            expires_in: 3600,
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(new Response("[]", { status: 200 }));
    const refreshStoredTokens = vi.fn(async (_refreshToken: string, options?: {
      fetchImpl?: typeof fetch;
    }) => {
      const response = await options?.fetchImpl?.("https://login.procore.com/oauth/token", {
        method: "POST",
      });
      const data = await response?.json();
      return data.access_token as string;
    });

    await listCompanyProjectsPage("598134325683880", 1, 5, {
      fetchImpl: fetchMock,
      getStoredTokens: vi.fn().mockResolvedValue({
        accessToken: "expired-access",
        refreshToken: "refresh-token",
        expiresAt: new Date(Date.now() - 1000),
        scopes: ["read"],
        accountEmail: "admin@trock.dev",
        accountName: "Admin User",
        status: "active",
        lastError: null,
      }),
      refreshStoredTokens,
    });

    expect(refreshStoredTokens).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://login.procore.com/oauth/token");
    expect(fetchMock.mock.calls[1]?.[1]?.headers?.Authorization).toBe("Bearer refreshed-access");
    expect(fetchMock.mock.calls[1]?.[1]?.headers?.["Procore-Company-Id"]).toBe("598134325683880");
  });

  it.each([401, 403])(
    "marks stored oauth tokens as reauth_needed and throws PROCORE_OAUTH_REQUIRED when an oauth-backed GET returns %s",
    async (statusCode) => {
      const markOauthReauthNeeded = vi.fn().mockResolvedValue(undefined);
      const fetchMock = vi.fn().mockResolvedValue(
        new Response("auth failed", { status: statusCode })
      );

      const request = listCompanyProjectsPage("598134325683880", 1, 5, {
        fetchImpl: fetchMock,
        getStoredTokens: vi.fn().mockResolvedValue({
          accessToken: "oauth-token",
          refreshToken: "refresh-token",
          expiresAt: new Date(Date.now() + 120_000),
          scopes: ["read"],
          accountEmail: "admin@trock.dev",
          accountName: "Admin User",
          status: "active",
          lastError: null,
        }),
        markOauthReauthNeeded,
      });

      await expect(request).rejects.toThrow("PROCORE_OAUTH_REQUIRED");
      expect(markOauthReauthNeeded).toHaveBeenCalledOnce();
      expect(markOauthReauthNeeded).toHaveBeenCalledWith(`oauth read failed: ${statusCode}`);
    }
  );

  it("flattens structured Procore addresses into matcher-friendly city/state/address fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: 1,
            name: "Structured Address Project",
            display_name: "Structured Address Project",
            project_number: "TR-900",
            city: null,
            state_code: null,
            address: {
              street: "6212 Crow Lane",
              city: "Austin",
              state_code: "TX",
              zip: "78745",
              country_code: "US",
            },
            updated_at: "2026-04-13T00:00:00.000Z",
          },
        ]),
        { status: 200 }
      )
    );

    const result = await listCompanyProjectsPage("598134325683880", 1, 5, {
      fetchImpl: fetchMock,
      getStoredTokens: vi.fn().mockResolvedValue({
        accessToken: "oauth-token",
        refreshToken: "refresh-token",
        expiresAt: new Date(Date.now() + 120_000),
        scopes: ["read"],
        accountEmail: "admin@trock.dev",
        accountName: "Admin User",
        status: "active",
        lastError: null,
      }),
    });

    expect(result[0]).toMatchObject({
      projectNumber: "TR-900",
      city: "Austin",
      state: "TX",
      address: "6212 Crow Lane",
    });
  });

  it("accepts camelCase project number fields when Procore omits snake_case project_number", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: 1,
            name: "Camel Project Number",
            display_name: "Camel Project Number",
            projectNumber: "TR-901",
            city: "Dallas",
            state_code: "TX",
            address: "100 Main St",
            updated_at: "2026-04-13T00:00:00.000Z",
          },
        ]),
        { status: 200 }
      )
    );

    const result = await listCompanyProjectsPage("598134325683880", 1, 5, {
      fetchImpl: fetchMock,
      getStoredTokens: vi.fn().mockResolvedValue({
        accessToken: "oauth-token",
        refreshToken: "refresh-token",
        expiresAt: new Date(Date.now() + 120_000),
        scopes: ["read"],
        accountEmail: "admin@trock.dev",
        accountName: "Admin User",
        status: "active",
        lastError: null,
      }),
    });

    expect(result[0]?.projectNumber).toBe("TR-901");
  });
});
