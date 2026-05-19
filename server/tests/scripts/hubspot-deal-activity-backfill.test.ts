import { describe, expect, it, vi } from "vitest";

const {
  parseBackfillArgs,
  renderBackfillReport,
  runBackfill,
} = await import("../../../scripts/hubspot-deal-activity-backfill.ts");

function makeEngagement(
  id: string,
  type: "note" | "call" | "meeting" | "email",
  ownerId = "owner-1",
  associations: Record<string, unknown> = { deals: { results: [{ id: "hubspot-deal-1" }] } }
) {
  return {
    id,
    objectType: type,
    properties: {
      hs_timestamp: "2026-05-01T00:00:00.000Z",
      hubspot_owner_id: ownerId,
    },
    associations,
  };
}

function makeDeps() {
  const imported = new Set<string>();
  return {
    getAvailableTypes: () => ["note", "call", "meeting", "email"] as const,
    fetchOwners: vi.fn(async () => [{ id: "owner-1", email: "rep@trock.com" }]),
    fetchEngagementsByType: vi.fn(async (type: string) => [makeEngagement(`hs-${type}-1`, type as any)]),
    getExistingLedgerEntry: vi.fn(async (_db: unknown, _schema: string, type: string, id: string) =>
      imported.has(`${type}:${id}`) ? { status: "imported" } : null
    ),
    findTargetEntityForHubspotEngagement: vi.fn(async () => ({
      type: "deal",
      id: "deal-1",
      entity: { id: "deal-1", name: "Jefferson on The Lake", hubspotDealId: "hubspot-deal-1" },
      hubspotDealIds: ["hubspot-deal-1"],
      hubspotCompanyIds: [],
      hubspotContactIds: [],
    })),
    findUserForHubspotOwner: vi.fn(async () => ({
      id: "user-1",
      email: "rep@trock.com",
      displayName: "Rep One",
    })),
    mapNoteToActivity: vi.fn(() => ({ type: "note" })),
    mapCallToActivity: vi.fn(() => ({ type: "call" })),
    mapMeetingToActivity: vi.fn(() => ({ type: "meeting" })),
    mapEmailToRecords: vi.fn(() => ({ email: { graphMessageId: "hubspot:1" }, activity: { type: "email" } })),
    writeAtomic: vi.fn(async (_db: unknown, payload: { ledger: { hubspotObjectType: string; hubspotObjectId: string } }) => {
      imported.add(`${payload.ledger.hubspotObjectType}:${payload.ledger.hubspotObjectId}`);
      return {
        activityId: "activity-1",
        emailId: payload.ledger.hubspotObjectType === "email" ? "email-1" : null,
        didImport: true,
      };
    }),
    writeLedgerOnly: vi.fn(async (_db: unknown, payload: { hubspotObjectType: string; hubspotObjectId: string }) => {
      imported.add(`${payload.hubspotObjectType}:${payload.hubspotObjectId}`);
    }),
    createConnections: vi.fn(async () => ({
      publicDb: {},
      tenantDb: {},
      close: async () => undefined,
    })),
    validateOffice: vi.fn(async () => ({ schemaName: "office_dallas", officeSlug: "dallas", officeId: "office-1" })),
  };
}

describe("hubspot-deal-activity-backfill script", () => {
  it("parses note pilot dry-run by default", () => {
    const args = parseBackfillArgs(["node", "script", "--office=office_dallas"]);
    expect(args).toMatchObject({
      office: "office_dallas",
      type: "note",
      mode: "dry-run",
    });
  });

  it("rejects conflicting dry-run and execute flags", () => {
    expect(() =>
      parseBackfillArgs(["node", "script", "--office=office_dallas", "--dry-run", "--execute"])
    ).toThrow("--dry-run and --execute are mutually exclusive");
  });

  it("rejects impossible calendar dates for --since", () => {
    expect(() =>
      parseBackfillArgs(["node", "script", "--office=office_dallas", "--since=2026-02-30"])
    ).toThrow("Invalid --since value: 2026-02-30");
  });

  it("requires an office argument", () => {
    expect(() => parseBackfillArgs(["node", "script"])).toThrow("--office is required");
  });

  it("keeps dry-run read-only", async () => {
    const deps = makeDeps();

    const report = await runBackfill(
      { office: "office_dallas", type: "note", mode: "dry-run", since: null, limit: null, dealId: null },
      deps as any
    );

    expect(report.byType.note?.fetched).toBe(1);
    expect(report.byType.note?.wouldImport).toBe(1);
    expect(report.byType.note?.wouldImportToDeals).toBe(1);
    expect(deps.writeAtomic).not.toHaveBeenCalled();
    expect(deps.writeLedgerOnly).not.toHaveBeenCalled();
  });

  it("imports notes only when --type=note is selected", async () => {
    const deps = makeDeps();

    await runBackfill(
      { office: "office_dallas", type: "note", mode: "execute", since: null, limit: null, dealId: null },
      deps as any
    );

    expect(deps.fetchEngagementsByType).toHaveBeenCalledTimes(1);
    expect(deps.fetchEngagementsByType).toHaveBeenCalledWith("note", expect.any(Object));
    expect(deps.mapNoteToActivity).toHaveBeenCalledTimes(1);
    expect(deps.mapCallToActivity).not.toHaveBeenCalled();
    expect(deps.mapMeetingToActivity).not.toHaveBeenCalled();
    expect(deps.mapEmailToRecords).not.toHaveBeenCalled();
  });

  it("passes the validated office scope into HubSpot owner resolution", async () => {
    const deps = makeDeps();

    await runBackfill(
      { office: "office_dallas", type: "note", mode: "execute", since: null, limit: null, dealId: null },
      deps as any
    );

    expect(deps.findUserForHubspotOwner).toHaveBeenCalledWith({}, "owner-1", expect.any(Map), "office-1");
  });

  it("imports all four supported types when --type=all is selected", async () => {
    const deps = makeDeps();

    const report = await runBackfill(
      { office: "office_dallas", type: "all", mode: "execute", since: null, limit: null, dealId: null },
      deps as any
    );

    expect(report.byType.note?.imported).toBe(1);
    expect(report.byType.call?.imported).toBe(1);
    expect(report.byType.meeting?.imported).toBe(1);
    expect(report.byType.email?.imported).toBe(1);
    expect(deps.fetchEngagementsByType).toHaveBeenCalledTimes(4);
  });

  it("tracks imported entity-type breakdowns in the report", async () => {
    const deps = makeDeps();
    deps.fetchEngagementsByType.mockResolvedValueOnce([
      makeEngagement("hs-note-1", "note", "owner-1", { deals: { results: [] }, companies: { results: [{ id: "hubspot-company-1" }] }, contacts: { results: [] } }),
      makeEngagement("hs-note-2", "note", "owner-1", { deals: { results: [] }, companies: { results: [] }, contacts: { results: [{ id: "hubspot-contact-1" }] } }),
      makeEngagement("hs-note-3", "note"),
    ]);
    deps.findTargetEntityForHubspotEngagement
      .mockResolvedValueOnce({
        type: "company",
        id: "company-1",
        entity: { id: "company-1", name: "Acme Roofing", hubspotCompanyId: "hubspot-company-1", hubspotId: null },
        hubspotDealIds: [],
        hubspotCompanyIds: ["hubspot-company-1"],
        hubspotContactIds: [],
      })
      .mockResolvedValueOnce({
        type: "contact",
        id: "contact-1",
        entity: { id: "contact-1", firstName: "Jane", lastName: "Client", companyId: "company-1", hubspotContactId: "hubspot-contact-1" },
        hubspotDealIds: [],
        hubspotCompanyIds: [],
        hubspotContactIds: ["hubspot-contact-1"],
      })
      .mockResolvedValueOnce({
        type: "deal",
        id: "deal-1",
        entity: { id: "deal-1", name: "Jefferson on The Lake", hubspotDealId: "hubspot-deal-1" },
        hubspotDealIds: ["hubspot-deal-1"],
        hubspotCompanyIds: [],
        hubspotContactIds: [],
      });

    const report = await runBackfill(
      { office: "office_dallas", type: "note", mode: "execute", since: null, limit: null, dealId: null },
      deps as any
    );

    expect(report.byType.note).toMatchObject({
      imported: 3,
      importedToDeals: 1,
      importedToCompanies: 1,
      importedToContacts: 1,
    });

    const rendered = renderBackfillReport(report);
    expect(rendered).toContain("Imported to deals: 1");
    expect(rendered).toContain("Imported to companies: 1");
    expect(rendered).toContain("Imported to contacts: 1");
  });

  it("treats a second execute run as already imported for the same engagement", async () => {
    const deps = makeDeps();
    const args = { office: "office_dallas", type: "note", mode: "execute" as const, since: null, limit: null, dealId: null };

    const first = await runBackfill(args, deps as any);
    const second = await runBackfill(args, deps as any);

    expect(first.byType.note?.imported).toBe(1);
    expect(second.byType.note?.alreadyImported).toBe(1);
  });

  it("can promote a previously skipped engagement after mappings are repaired", async () => {
    const deps = makeDeps();
    const ledgerState = new Map<string, { status: string }>();
    deps.getExistingLedgerEntry = vi.fn(async (_db: unknown, _schema: string, type: string, id: string) => {
      return ledgerState.get(`${type}:${id}`) ?? null;
    });
    deps.writeLedgerOnly = vi.fn(
      async (_db: unknown, payload: { hubspotObjectType: string; hubspotObjectId: string; status: string }) => {
        ledgerState.set(`${payload.hubspotObjectType}:${payload.hubspotObjectId}`, { status: payload.status });
      }
    );
    deps.writeAtomic = vi.fn(
      async (_db: unknown, payload: { ledger: { hubspotObjectType: string; hubspotObjectId: string; status: string } }) => {
        ledgerState.set(`${payload.ledger.hubspotObjectType}:${payload.ledger.hubspotObjectId}`, {
          status: payload.ledger.status,
        });
        return { activityId: "activity-1", emailId: null, didImport: true };
      }
    );
    deps.findUserForHubspotOwner
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "user-1", email: "rep@trock.com", displayName: "Rep One" });

    const args = {
      office: "office_dallas",
      type: "note",
      mode: "execute" as const,
      since: null,
      limit: null,
      dealId: null,
    };
    const first = await runBackfill(args, deps as any);
    const second = await runBackfill(args, deps as any);

    expect(first.byType.note?.skippedUnmappedUser).toBe(1);
    expect(second.byType.note?.imported).toBe(1);
  });

  it("counts orphan, ambiguous, and unmapped user skips", async () => {
    const deps = makeDeps();
    deps.fetchEngagementsByType.mockResolvedValueOnce([
      makeEngagement("hs-note-1", "note", "owner-1", { deals: { results: [] }, companies: { results: [] }, contacts: { results: [] } }),
      makeEngagement("hs-note-2", "note"),
      makeEngagement("hs-note-3", "note"),
    ]);
    deps.findTargetEntityForHubspotEngagement
      .mockResolvedValueOnce({
        type: "orphan",
        hubspotDealIds: [],
        hubspotCompanyIds: [],
        hubspotContactIds: [],
        reason: "HubSpot engagement had no deal, company, or contact associations",
      })
      .mockResolvedValueOnce({
        type: "ambiguous",
        hubspotDealIds: ["hubspot-deal-1", "hubspot-deal-2"],
        hubspotCompanyIds: [],
        hubspotContactIds: [],
        reason: "Multiple active T Rock deals matched the HubSpot deal association",
      })
      .mockResolvedValueOnce({
        type: "deal",
        id: "deal-1",
        entity: { id: "deal-1", name: "Jefferson on The Lake", hubspotDealId: "hubspot-deal-1" },
        hubspotDealIds: ["hubspot-deal-1"],
        hubspotCompanyIds: [],
        hubspotContactIds: [],
      });
    deps.findUserForHubspotOwner.mockResolvedValueOnce(null);

    const report = await runBackfill(
      { office: "office_dallas", type: "note", mode: "execute", since: null, limit: null, dealId: null },
      deps as any
    );

    expect(report.byType.note?.skippedOrphan).toBe(1);
    expect(report.byType.note?.skippedAmbiguous).toBe(1);
    expect(report.byType.note?.skippedUnmappedUser).toBe(1);
    expect(deps.writeAtomic).not.toHaveBeenCalled();
    expect(deps.writeLedgerOnly).toHaveBeenCalledTimes(3);
  });

  it("counts raced idempotent rows as already imported instead of imported", async () => {
    const deps = makeDeps();
    deps.writeAtomic.mockResolvedValueOnce({ activityId: "activity-1", emailId: null, didImport: false });

    const report = await runBackfill(
      { office: "office_dallas", type: "note", mode: "execute", since: null, limit: null, dealId: null },
      deps as any
    );

    expect(report.byType.note?.imported).toBe(0);
    expect(report.byType.note?.alreadyImported).toBe(1);
  });

  it("filters pilot execution to the requested deal id", async () => {
    const deps = makeDeps();
    deps.fetchEngagementsByType.mockResolvedValueOnce([
      makeEngagement("hs-note-1", "note"),
      makeEngagement("hs-note-2", "note"),
    ]);
    deps.findTargetEntityForHubspotEngagement
      .mockResolvedValueOnce({
        type: "company",
        id: "company-1",
        entity: { id: "company-1", name: "Acme Roofing", hubspotCompanyId: "hubspot-company-1", hubspotId: null },
        hubspotDealIds: [],
        hubspotCompanyIds: ["hubspot-company-1"],
        hubspotContactIds: [],
      })
      .mockResolvedValueOnce({
        type: "deal",
        id: "deal-allowed",
        entity: { id: "deal-allowed", name: "Allowed Deal", hubspotDealId: "hubspot-deal-1" },
        hubspotDealIds: ["hubspot-deal-1"],
        hubspotCompanyIds: [],
        hubspotContactIds: [],
      });

    const report = await runBackfill(
      { office: "office_dallas", type: "note", mode: "execute", since: null, limit: null, dealId: "deal-allowed" },
      deps as any
    );

    expect(report.byType.note?.imported).toBe(1);
    expect(report.byType.note?.importedToDeals).toBe(1);
    expect(report.byType.note?.importedToCompanies).toBe(0);
  });
});
