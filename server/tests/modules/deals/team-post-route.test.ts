import { describe, expect, it, vi, beforeEach } from "vitest";

// Route-handler-direct harness (mirrors read-routes-office-access.test.ts): mock the deals router's
// service deps, mount the real router, invoke the POST /:id/team handler directly. Locks the one-of
// (userId XOR contactId) validation + the referenced-entity existence checks the route enforces before
// it delegates to addTeamMember.

const serviceMocks = vi.hoisted(() => ({
  getDealById: vi.fn(async () => ({ id: "deal-1", name: "Maple St" })),
}));
const teamMocks = vi.hoisted(() => ({
  addTeamMember: vi.fn(async (_db: any, input: any) => ({ id: "member-1", ...input })),
  getTeamMembers: vi.fn(),
  updateTeamMember: vi.fn(),
  removeTeamMember: vi.fn(),
}));
const usersMock = vi.hoisted(() => ({ listUsers: vi.fn(async () => [] as any[]) }));
const contactsMock = vi.hoisted(() => ({ getContactById: vi.fn(async () => null as any) }));

// Spread the REAL service module so every name routes.ts imports (setDealEstimator, setDealSalesSource,
// validateAssignee, assertSalesSourceIsCrmUser, …) stays defined — only getDealById is intentionally
// stubbed for this harness. A hand-listed subset silently omits any newly-imported service export and would
// make the router import throw the moment one is referenced.
vi.mock("../../../src/modules/deals/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/modules/deals/service.js")>()),
  getDealById: serviceMocks.getDealById,
}));
vi.mock("../../../src/modules/deals/team-service.js", () => teamMocks);
vi.mock("../../../src/modules/admin/users-service.js", () => usersMock);
vi.mock("../../../src/modules/contacts/service.js", () => contactsMock);
vi.mock("../../../src/modules/deals/stage-change.js", () => ({ activateServiceHandoff: vi.fn(), changeDealStage: vi.fn() }));
vi.mock("../../../src/modules/deals/stage-gate.js", () => ({ preflightStageCheck: vi.fn() }));
vi.mock("../../../src/modules/contacts/association-service.js", () => ({ getContactsForDeal: vi.fn() }));
vi.mock("../../../src/modules/deals/estimate-service.js", () => ({
  getEstimate: vi.fn(), createSection: vi.fn(), updateSection: vi.fn(), deleteSection: vi.fn(),
  createLineItem: vi.fn(), updateLineItem: vi.fn(), deleteLineItem: vi.fn(),
}));
vi.mock("../../../src/modules/deals/punch-list-service.js", () => ({
  getPunchList: vi.fn(), createPunchListItem: vi.fn(), updatePunchListItem: vi.fn(),
  deletePunchListItem: vi.fn(), completePunchListItem: vi.fn(),
}));
vi.mock("../../../src/modules/deals/timer-service.js", () => ({
  getTimers: vi.fn(), createTimer: vi.fn(), completeTimer: vi.fn(), cancelTimer: vi.fn(),
}));
vi.mock("../../../src/modules/deals/closeout-service.js", () => ({
  getCloseoutChecklist: vi.fn(), initializeCloseoutChecklist: vi.fn(), toggleChecklistItem: vi.fn(), updateChecklistItem: vi.fn(),
}));
vi.mock("../../../src/modules/deals/scoping-service.js", () => ({
  evaluateDealScopingReadiness: vi.fn(), getOrCreateDealScopingIntake: vi.fn(),
  linkDealFileToScopingRequirement: vi.fn(), routeRevisionToEstimating: vi.fn(), upsertDealScopingIntake: vi.fn(),
}));
vi.mock("../../../src/modules/deals/lineage-resolver.js", () => ({ writeResolvedDealFields: vi.fn() }));
vi.mock("../../../src/modules/deals/workflow-backfill.js", () => ({ inferDealBidBoardOwnership: vi.fn() }));
vi.mock("../../../src/lib/collaboration-access.js", () => ({
  assertDealCollaboratorAccess: vi.fn(), assertDealOwnerAccess: vi.fn(),
  getCollaborativeReadRole: vi.fn((role: string) => role),
  normalizeCollaborativeScope: vi.fn((_role: string, scope: any) => scope ?? "mine"),
}));
vi.mock("../../../src/events/bus.js", () => ({
  eventBus: { emitLocal: vi.fn(), on: vi.fn(), emit: vi.fn(), setMaxListeners: vi.fn() },
}));

const { dealRoutes } = await import("../../../src/modules/deals/routes.js");

// Real UUIDs — the route now validates userId/contactId FORMAT before any DB lookup (a non-UUID would
// otherwise reach a `::uuid` comparison and surface as a generic 500).
const USER_UUID = "33333333-3333-3333-3333-333333333333";
const CONTACT_UUID = "44444444-4444-4444-4444-444444444444";

function findRouteHandler(method: string, path: string) {
  const layer = (dealRoutes as any).stack.find(
    (entry: any) => entry.route?.path === path && entry.route?.methods?.[method],
  );
  if (!layer) throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  return layer.route.stack.find((entry: any) => entry.method === method).handle;
}

async function postTeam(body: any) {
  const handler = findRouteHandler("post", "/:id/team");
  const req = {
    params: { id: "deal-1" },
    query: {},
    body,
    tenantDb: {},
    user: { id: "rep-1", role: "rep", officeId: "office-1", activeOfficeId: "office-1" },
    commitTransaction: vi.fn(async () => {}),
  } as any;
  const res = {
    statusCode: 200,
    body: undefined as any,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: any) { this.body = payload; return this; },
    send() { return this; },
  } as any;
  let nextErr: any;
  await handler(req, res, (err?: unknown) => { nextErr = err; });
  return { res, nextErr };
}

beforeEach(() => {
  vi.clearAllMocks();
  serviceMocks.getDealById.mockResolvedValue({ id: "deal-1", name: "Maple St" } as any);
  usersMock.listUsers.mockResolvedValue([] as any);
  contactsMock.getContactById.mockResolvedValue(null as any);
});

describe("POST /:id/team one-of validation", () => {
  it("400s when neither userId nor contactId is provided", async () => {
    const { nextErr } = await postTeam({ role: "superintendent" });
    expect(nextErr).toMatchObject({ statusCode: 400 });
    expect(String(nextErr.message)).toMatch(/exactly one of userId or contactId/i);
    expect(teamMocks.addTeamMember).not.toHaveBeenCalled();
  });

  it("400s when BOTH userId and contactId are provided", async () => {
    const { nextErr } = await postTeam({ userId: "u-1", contactId: "c-1", role: "superintendent" });
    expect(nextErr).toMatchObject({ statusCode: 400 });
    expect(String(nextErr.message)).toMatch(/exactly one of userId or contactId/i);
  });

  it("400s for an invalid role", async () => {
    const { nextErr } = await postTeam({ userId: USER_UUID, role: "not_a_role" });
    expect(nextErr).toMatchObject({ statusCode: 400 });
    expect(String(nextErr.message)).toMatch(/invalid role/i);
  });

  it("400s (not 500) for a truthy non-UUID userId, before any DB lookup", async () => {
    const { nextErr } = await postTeam({ userId: "abc", role: "project_manager" });
    expect(nextErr).toMatchObject({ statusCode: 400 });
    expect(String(nextErr.message)).toMatch(/uuid/i);
    expect(usersMock.listUsers).not.toHaveBeenCalled();
    expect(teamMocks.addTeamMember).not.toHaveBeenCalled();
  });

  it("400s (not 500) for a truthy non-UUID contactId, before the contact lookup", async () => {
    const { nextErr } = await postTeam({ contactId: "abc", role: "superintendent" });
    expect(nextErr).toMatchObject({ statusCode: 400 });
    expect(String(nextErr.message)).toMatch(/uuid/i);
    expect(contactsMock.getContactById).not.toHaveBeenCalled();
    expect(teamMocks.addTeamMember).not.toHaveBeenCalled();
  });

  it("400s for a CONTACT-backed estimator (routing ignores contact estimators)", async () => {
    const { nextErr } = await postTeam({ contactId: CONTACT_UUID, role: "estimator" });
    expect(nextErr).toMatchObject({ statusCode: 400 });
    expect(String(nextErr.message)).toMatch(/Estimator must be a staff user/i);
    expect(contactsMock.getContactById).not.toHaveBeenCalled();
    expect(teamMocks.addTeamMember).not.toHaveBeenCalled();
  });
});

describe("POST /:id/team user assignment", () => {
  it("assigns an active in-office user", async () => {
    usersMock.listUsers.mockResolvedValue([{ id: USER_UUID, isActive: true }] as any);
    const { res, nextErr } = await postTeam({ userId: USER_UUID, role: "project_manager" });
    expect(nextErr).toBeUndefined();
    expect(res.statusCode).toBe(201);
    expect(teamMocks.addTeamMember).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: USER_UUID, contactId: null, role: "project_manager" }),
    );
  });

  it("assigns a STAFF-USER estimator (a contact estimator is rejected above)", async () => {
    usersMock.listUsers.mockResolvedValue([{ id: USER_UUID, isActive: true }] as any);
    const { res, nextErr } = await postTeam({ userId: USER_UUID, role: "estimator" });
    expect(nextErr).toBeUndefined();
    expect(res.statusCode).toBe(201);
    expect(teamMocks.addTeamMember).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: USER_UUID, role: "estimator" }),
    );
  });

  it("400s when the user is not an active member of the office", async () => {
    usersMock.listUsers.mockResolvedValue([{ id: USER_UUID, isActive: false }] as any);
    const { nextErr } = await postTeam({ userId: USER_UUID, role: "project_manager" });
    expect(nextErr).toMatchObject({ statusCode: 400 });
    expect(teamMocks.addTeamMember).not.toHaveBeenCalled();
  });

  it("400s when the user is not in the office roster at all", async () => {
    usersMock.listUsers.mockResolvedValue([{ id: "55555555-5555-5555-5555-555555555555", isActive: true }] as any);
    const { nextErr } = await postTeam({ userId: USER_UUID, role: "project_manager" });
    expect(nextErr).toMatchObject({ statusCode: 400 });
  });
});

describe("POST /:id/team email-only member (spec §4.4)", () => {
  it("delegates an email-only super to addTeamMember with memberName/memberEmail (no user/contact lookup)", async () => {
    const { res, nextErr } = await postTeam({
      role: "superintendent",
      memberName: "Ext Super",
      memberEmail: "ext.super@example.com",
    });
    expect(nextErr).toBeUndefined();
    expect(res.statusCode).toBe(201);
    expect(usersMock.listUsers).not.toHaveBeenCalled();
    expect(contactsMock.getContactById).not.toHaveBeenCalled();
    expect(teamMocks.addTeamMember).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        memberName: "Ext Super",
        memberEmail: "ext.super@example.com",
        role: "superintendent",
      }),
    );
  });

  it("does NOT take the email-only path when a userId is also provided (falls through to one-of)", async () => {
    usersMock.listUsers.mockResolvedValue([{ id: USER_UUID, isActive: true }] as any);
    const { res, nextErr } = await postTeam({
      userId: USER_UUID,
      role: "project_manager",
      memberEmail: "ext@example.com",
    });
    // The linked-user path wins; addTeamMember is called with the user id, not the email-only shape.
    expect(nextErr).toBeUndefined();
    expect(res.statusCode).toBe(201);
    expect(teamMocks.addTeamMember).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: USER_UUID }),
    );
  });
});

describe("POST /:id/team contact assignment", () => {
  it("assigns an active directory contact", async () => {
    contactsMock.getContactById.mockResolvedValue({ id: CONTACT_UUID, isActive: true } as any);
    const { res, nextErr } = await postTeam({ contactId: CONTACT_UUID, role: "superintendent" });
    expect(nextErr).toBeUndefined();
    expect(res.statusCode).toBe(201);
    expect(teamMocks.addTeamMember).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ contactId: CONTACT_UUID, userId: null, role: "superintendent" }),
    );
  });

  it("400s when the contact does not exist", async () => {
    contactsMock.getContactById.mockResolvedValue(null as any);
    const { nextErr } = await postTeam({ contactId: CONTACT_UUID, role: "superintendent" });
    expect(nextErr).toMatchObject({ statusCode: 400 });
    expect(teamMocks.addTeamMember).not.toHaveBeenCalled();
  });

  it("400s when the contact is inactive", async () => {
    contactsMock.getContactById.mockResolvedValue({ id: CONTACT_UUID, isActive: false } as any);
    const { nextErr } = await postTeam({ contactId: CONTACT_UUID, role: "superintendent" });
    expect(nextErr).toMatchObject({ statusCode: 400 });
  });
});
