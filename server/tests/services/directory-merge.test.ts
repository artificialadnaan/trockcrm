import { describe, expect, it } from "vitest";
import {
  activities,
  aiDisconnectCases,
  aiDocumentIndex,
  callRecordings,
  companies,
  contacts,
  deals,
  directoryMergeAudit,
  directoryMergeQueue,
  emails,
  leads,
  properties,
} from "@trock-crm/shared/schema";
import {
  COMPANY_REPOINT_TARGETS,
  selectMergeWinner,
  clusterCompaniesByName,
  classifyNameCluster,
  planFieldReconciliation,
  buildClusterMergePlan,
  mergeDirectoryEntities,
  unmergeDirectoryEntities,
  type CompanyMergeMember,
} from "../../src/services/directoryDedup.js";

const TABLE_NAME = new Map<unknown, string>([
  [companies, "companies"],
  [contacts, "contacts"],
  [deals, "deals"],
  [leads, "leads"],
  [properties, "properties"],
  [activities, "activities"],
  [aiDocumentIndex, "ai_document_index"],
  [aiDisconnectCases, "ai_disconnect_cases"],
  [emails, "emails"],
  [callRecordings, "call_recordings"],
  [directoryMergeAudit, "directory_merge_audit"],
  [directoryMergeQueue, "directory_merge_queue"],
]);

// Records every update()/insert() and serves winner/loser rows + canned moved-row
// ids, so we can assert which tables a merge re-points and what it captures.
function recordingDb(
  winnerRow: Record<string, unknown>,
  loserRow: Record<string, unknown>,
  captureIds: Record<string, string[]> = {}
) {
  const updates: Array<{ table: string; values: Record<string, unknown> }> = [];
  const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];
  let companyFetch = 0;
  const captureRows = (table: unknown) => {
    const name = TABLE_NAME.get(table) ?? "unknown";
    return (captureIds[name] ?? [`${name}-r1`]).map((id) => ({ id }));
  };
  const db = {
    select: (_cols?: unknown) => ({
      from: (table: unknown) => ({
        where: (_cond: unknown) => ({
          then: (resolve: (rows: unknown) => unknown) => resolve(captureRows(table)),
          limit: (_n: number) => {
            if (table === companies) {
              companyFetch += 1;
              return Promise.resolve([companyFetch === 1 ? winnerRow : loserRow]);
            }
            return Promise.resolve(captureRows(table));
          },
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: (_cond: unknown) => {
          updates.push({ table: TABLE_NAME.get(table) ?? "unknown", values });
          return Promise.resolve(undefined);
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserts.push({ table: TABLE_NAME.get(table) ?? "unknown", values });
        return Promise.resolve(undefined);
      },
    }),
    execute: async () => ({ rows: [{ locked: true }] }),
  };
  return { db, updates, inserts };
}

function companyRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "id",
    name: "Acme",
    address: null,
    city: null,
    state: null,
    zip: null,
    phone: null,
    website: null,
    domain: null,
    hubspotId: null,
    hubspotCompanyId: null,
    procoreId: null,
    industry: null,
    region: null,
    sourceRefs: {},
    ...over,
  };
}

function member(over: Partial<CompanyMergeMember> = {}): CompanyMergeMember {
  return {
    id: "id",
    name: "Acme",
    address: null,
    city: null,
    state: null,
    zip: null,
    phone: null,
    website: null,
    domain: null,
    hubspotId: null,
    hubspotCompanyId: null,
    procoreId: null,
    industry: null,
    region: null,
    createdAt: "2026-05-07T00:00:00.000Z",
    dealCount: 0,
    contactCount: 0,
    ...over,
  };
}

describe("COMPANY_REPOINT_TARGETS (the complete re-point map)", () => {
  it("covers every reference a safe company merge must move (per the discovery)", () => {
    const keys = COMPANY_REPOINT_TARGETS.map((t) => t.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        "deals",
        "contacts",
        "leads",
        "properties",
        "activities",
        "activities_source_entity",
        "ai_document_index",
        "ai_disconnect_cases",
        "emails_assigned_entity",
        "call_recordings_entity",
      ])
    );
  });

  it("marks the three polymorphic targets with a discriminator", () => {
    const poly = COMPANY_REPOINT_TARGETS.filter((t) => t.discriminatorColumn);
    expect(poly.map((t) => t.key).sort()).toEqual([
      "activities_source_entity",
      "call_recordings_entity",
      "emails_assigned_entity",
    ]);
    for (const t of poly) expect(t.discriminatorValue).toBe("company");
  });
});

describe("selectMergeWinner", () => {
  it("picks the member with the most deals (Mack: 89 beats 66)", () => {
    expect(
      selectMergeWinner([
        member({ id: "a", dealCount: 89, address: null }),
        member({ id: "b", dealCount: 66, address: "60 Columbus Circle" }),
      ])
    ).toBe("a");
  });

  it("breaks a deal-count tie by preferring a member that has an address", () => {
    expect(
      selectMergeWinner([
        member({ id: "a", dealCount: 5, address: null }),
        member({ id: "b", dealCount: 5, address: "123 Main" }),
      ])
    ).toBe("b");
  });

  it("breaks remaining ties by contact count, then oldest created, then lowest id", () => {
    expect(
      selectMergeWinner([
        member({ id: "z", dealCount: 0, address: null, contactCount: 1, createdAt: "2026-05-09T00:00:00.000Z" }),
        member({ id: "y", dealCount: 0, address: null, contactCount: 5, createdAt: "2026-05-09T00:00:00.000Z" }),
      ])
    ).toBe("y"); // more contacts wins

    expect(
      selectMergeWinner([
        member({ id: "b", dealCount: 0, contactCount: 0, createdAt: "2026-05-09T00:00:00.000Z" }),
        member({ id: "a", dealCount: 0, contactCount: 0, createdAt: "2026-05-07T00:00:00.000Z" }),
      ])
    ).toBe("a"); // older wins
  });
});

describe("clusterCompaniesByName", () => {
  it("groups by name regardless of zip and returns only clusters of size > 1", () => {
    const clusters = clusterCompaniesByName([
      member({ id: "a", name: "Mack Real Estate Group", zip: null }),
      member({ id: "b", name: "Mack Real Estate Group", zip: "10023" }),
      member({ id: "c", name: "Solo Co", zip: "75201" }),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].map((m) => m.id).sort()).toEqual(["a", "b"]);
  });

  it("does not collapse different names together", () => {
    const clusters = clusterCompaniesByName([
      member({ id: "a", name: "Walton Communities" }),
      member({ id: "b", name: "Walton Communities, LLC" }),
    ]);
    expect(clusters).toHaveLength(0);
  });
});

describe("classifyNameCluster (clearly_safe vs review)", () => {
  it("clearly_safe when websites agree and addresses are same-or-null (Mack)", () => {
    const r = classifyNameCluster([
      member({ website: "mackregroup.com", address: null }),
      member({ website: "https://mackregroup.com/", address: "60 Columbus Circle", city: "New York", state: "NY", zip: "10023" }),
    ]);
    expect(r.classification).toBe("clearly_safe");
  });

  it("review when websites diverge (Harbor Group: harborgroupint.com vs hgliving.com)", () => {
    const r = classifyNameCluster([
      member({ website: "harborgroupint.com", phone: "+13147275550" }),
      member({ website: "hgliving.com", phone: null }),
    ]);
    expect(r.classification).toBe("review");
    expect(r.reasons).toContain("divergent_website");
  });

  it("review when there are two distinct real addresses (branch-vs-duplicate)", () => {
    const r = classifyNameCluster([
      member({ address: "100 A St", city: "Dallas", state: "TX", zip: "75201" }),
      member({ address: "200 B Ave", city: "Austin", state: "TX", zip: "78701" }),
    ]);
    expect(r.classification).toBe("review");
    expect(r.reasons).toContain("divergent_address");
  });

  it("review when a zip is the literal placeholder 'Unknown' (Machine Investment)", () => {
    const r = classifyNameCluster([
      member({ phone: "(303) 623-5551", zip: "Unknown" }),
      member({ phone: "(303) 623-5551", zip: "Unknown" }),
    ]);
    expect(r.classification).toBe("review");
    expect(r.reasons).toContain("placeholder_zip");
  });
});

describe("planFieldReconciliation", () => {
  it("copies the loser's address tuple onto a winner that has no address", () => {
    const winner = member({ id: "a", dealCount: 89, address: null });
    const losers = [
      member({ id: "b", address: "60 Columbus Circle", city: "New York", state: "NY", zip: "10023" }),
    ];
    const plan = planFieldReconciliation(winner, losers);
    expect(plan.updates.address).toBe("60 Columbus Circle");
    expect(plan.updates.city).toBe("New York");
    expect(plan.updates.state).toBe("NY");
    expect(plan.updates.zip).toBe("10023");
    expect(plan.winnerBefore.address).toBe(null);
  });

  it("never overwrites a field the winner already has", () => {
    const winner = member({ id: "a", website: "winner.com", address: "1 Real St", city: "X", state: "TX", zip: "75201" });
    const losers = [member({ id: "b", website: "loser.com", address: "2 Other Rd", city: "Y", state: "TX", zip: "75002" })];
    const plan = planFieldReconciliation(winner, losers);
    expect(plan.updates.website).toBeUndefined();
    expect(plan.updates.address).toBeUndefined();
  });

  it("fills scalar fields (phone, hubspot ids) from the first loser that has them", () => {
    const winner = member({ id: "a", phone: null, hubspotCompanyId: null });
    const losers = [
      member({ id: "b", phone: null, hubspotCompanyId: "hs-1" }),
      member({ id: "c", phone: "555", hubspotCompanyId: "hs-2" }),
    ];
    const plan = planFieldReconciliation(winner, losers);
    expect(plan.updates.phone).toBe("555");
    expect(plan.updates.hubspotCompanyId).toBe("hs-1");
  });
});

describe("mergeDirectoryEntities (company) -- full re-point + audit capture", () => {
  async function runMerge(captureIds: Record<string, string[]> = {}) {
    const winnerRow = companyRow({ id: "W", name: "Mack Real Estate Group", website: "mackregroup.com" });
    const loserRow = companyRow({
      id: "L",
      name: "Mack Real Estate Group",
      website: "https://mackregroup.com/",
      address: "60 Columbus Circle",
      city: "New York",
      state: "NY",
      zip: "10023",
    });
    const rec = recordingDb(winnerRow, loserRow, captureIds);
    await mergeDirectoryEntities(rec.db as never, "company", "W", "L", {
      mode: "manual",
      confidenceScore: 1,
      matchReasons: ["name_match"],
    });
    return rec;
  }

  it("re-points every table in the complete map (not just contacts+deals)", async () => {
    const { updates } = await runMerge();
    const updated = updates.map((u) => u.table);
    for (const t of [
      "deals",
      "contacts",
      "leads",
      "properties",
      "activities",
      "ai_document_index",
      "ai_disconnect_cases",
      "emails",
      "call_recordings",
    ]) {
      expect(updated).toContain(t);
    }
  });

  it("re-points deals.company_id ONLY (Won basis invariant -- no value/date/stage write)", async () => {
    const { updates } = await runMerge();
    const dealsUpdate = updates.find((u) => u.table === "deals");
    expect(Object.keys(dealsUpdate!.values)).toEqual(["companyId"]);
  });

  it("refreshes the denormalized contacts.company_name snapshot to the winner", async () => {
    const { updates } = await runMerge();
    const contactsUpdate = updates.find((u) => u.table === "contacts");
    expect(contactsUpdate!.values).toHaveProperty("companyName", "Mack Real Estate Group");
  });

  it("reconciles the winner's empty address from the loser", async () => {
    const { updates } = await runMerge();
    const reconcile = updates.find((u) => u.table === "companies" && "address" in u.values);
    expect(reconcile?.values.address).toBe("60 Columbus Circle");
  });

  it("soft-deactivates the loser and stamps merged_into (never deletes)", async () => {
    const { updates } = await runMerge();
    const deactivate = updates.find((u) => u.table === "companies" && u.values.isActive === false);
    expect(deactivate).toBeDefined();
  });

  it("captures moved-row ids for EVERY target plus winnerBefore (so the merge is reversible)", async () => {
    const captureIds = {
      deals: ["d1", "d2"],
      activities: ["a1"],
      emails: ["e1"],
    };
    const { inserts } = await runMerge(captureIds);
    const audit = inserts.find((i) => i.table === "directory_merge_audit");
    const fc = audit!.values.fieldChanges as Record<string, unknown>;
    const moved = fc.movedRows as Record<string, string[]>;
    for (const key of COMPANY_REPOINT_TARGETS.map((t) => t.key)) {
      expect(moved).toHaveProperty(key);
    }
    expect(moved.deals).toEqual(["d1", "d2"]);
    expect(fc).toHaveProperty("winnerBefore");
    expect(fc).toHaveProperty("reconciled");
  });
});

function recordingUnmergeDb(
  auditRow: Record<string, unknown>,
  winnerRow: Record<string, unknown>,
  loserRow: Record<string, unknown>
) {
  const updates: Array<{ table: string; values: Record<string, unknown> }> = [];
  const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];
  let companyFetch = 0;
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: (_n: number) => {
            if (table === directoryMergeAudit) return Promise.resolve([auditRow]);
            if (table === companies) {
              companyFetch += 1;
              return Promise.resolve([companyFetch === 1 ? winnerRow : loserRow]);
            }
            return Promise.resolve([]);
          },
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: (_cond: unknown) => {
          updates.push({ table: TABLE_NAME.get(table) ?? "unknown", values });
          return Promise.resolve(undefined);
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserts.push({ table: TABLE_NAME.get(table) ?? "unknown", values });
        return Promise.resolve(undefined);
      },
    }),
  };
  return { db, updates, inserts };
}

describe("unmergeDirectoryEntities -- exact reversal", () => {
  const auditRow = {
    id: "audit-1",
    entityType: "company",
    mode: "merge",
    winnerId: "W",
    loserId: "L",
    confidenceScore: "1.000",
    matchReasons: ["name_match"],
    queueEntryId: null,
    fieldChanges: {
      loserIsActive: false,
      winnerId: "W",
      movedRows: {
        deals: ["d1", "d2"],
        contacts: ["c1"],
        leads: [],
        properties: ["p1"],
        activities: ["a1"],
        activities_source_entity: ["a2"],
        ai_document_index: [],
        ai_disconnect_cases: [],
        emails_assigned_entity: ["e1"],
        call_recordings_entity: [],
      },
      reconciled: { address: "60 Columbus Circle" },
      winnerBefore: { address: null },
    },
  };
  // Winner still holds the address the merge gave it -> compare-and-swap restores it.
  const winnerRow = { id: "W", name: "Mack Real Estate Group", address: "60 Columbus Circle" };
  const loserRow = { id: "L", name: "Mack Real Estate Group" };

  it("re-points captured rows back to the loser, restores the winner, reactivates the loser", async () => {
    const { db, updates, inserts } = recordingUnmergeDb(auditRow, winnerRow, loserRow);
    await unmergeDirectoryEntities(db as never, "audit-1");

    expect(updates.find((u) => u.table === "deals")?.values).toEqual({ companyId: "L" });
    expect(updates.find((u) => u.table === "contacts")?.values).toMatchObject({
      companyId: "L",
      companyName: "Mack Real Estate Group",
    });
    expect(updates.some((u) => u.table === "properties")).toBe(true);
    // activities re-pointed on BOTH columns (company_id + source_entity_id)
    expect(updates.filter((u) => u.table === "activities")).toHaveLength(2);
    expect(updates.some((u) => u.table === "emails")).toBe(true);
    // empty captures are not touched
    expect(updates.some((u) => u.table === "leads")).toBe(false);
    expect(updates.some((u) => u.table === "call_recordings")).toBe(false);
    expect(updates.some((u) => u.table === "ai_document_index")).toBe(false);

    // winner reconciled field restored to its pre-merge value (null) + loser reactivated
    expect(updates.some((u) => u.table === "companies" && u.values.address === null)).toBe(true);
    expect(updates.some((u) => u.table === "companies" && u.values.isActive === true)).toBe(true);

    const reversal = inserts.find((i) => i.table === "directory_merge_audit");
    expect(reversal?.values.mode).toBe("unmerge");
    expect((reversal?.values.fieldChanges as Record<string, unknown>).reversedAuditId).toBe("audit-1");
  });

  it("does NOT restore a winner field that was edited after the merge (compare-and-swap)", async () => {
    // Winner's address was changed post-merge -> current != reconciled -> leave it.
    const editedWinner = { id: "W", name: "Mack Real Estate Group", address: "999 Edited Later" };
    const { db, updates } = recordingUnmergeDb(auditRow, editedWinner, loserRow);
    await unmergeDirectoryEntities(db as never, "audit-1");
    expect(updates.some((u) => u.table === "companies" && "address" in u.values)).toBe(false);
  });

  it("rejects un-merge for a non-company audit row", async () => {
    const { db } = recordingUnmergeDb({ ...auditRow, entityType: "contact" }, winnerRow, loserRow);
    await expect(unmergeDirectoryEntities(db as never, "audit-1")).rejects.toThrow();
  });

  it("rejects un-merge of a non-merge (reversal) audit row", async () => {
    const { db } = recordingUnmergeDb({ ...auditRow, mode: "unmerge" }, winnerRow, loserRow);
    await expect(unmergeDirectoryEntities(db as never, "audit-1")).rejects.toThrow();
  });
});

describe("buildClusterMergePlan (dry-run assembly)", () => {
  it("assembles winner/losers, per-loser moves, reconciliation, and classification", () => {
    const members = [
      member({ id: "W", name: "Mack Real Estate Group", dealCount: 89, website: "mackregroup.com", address: null }),
      member({
        id: "L",
        name: "Mack Real Estate Group",
        dealCount: 66,
        website: "mackregroup.com",
        address: "60 Columbus Circle",
        city: "New York",
        state: "NY",
        zip: "10023",
      }),
    ];
    const plan = buildClusterMergePlan(members, {
      L: [
        { key: "deals", table: "deals", count: 66, ids: [] },
        { key: "properties", table: "properties", count: 66, ids: [] },
      ],
    });
    expect(plan.winnerId).toBe("W");
    expect(plan.losers.map((l) => l.id)).toEqual(["L"]);
    expect(plan.classification).toBe("clearly_safe");
    expect(plan.reconciliation.updates.address).toBe("60 Columbus Circle");
    expect(plan.loserPlans[0].totalRows).toBe(132);
    expect(plan.totalMovedRows).toBe(132);
  });

  it("flags a review cluster (divergent website) without changing the move math", () => {
    // Winner has the only contact -> wins on deal-count tie via contact count;
    // the loser's single contact is what moves.
    const members = [
      member({ id: "a", name: "Harbor Group Management", dealCount: 0, website: "harborgroupint.com", contactCount: 0 }),
      member({ id: "b", name: "Harbor Group Management", dealCount: 0, website: "hgliving.com", contactCount: 5 }),
    ];
    const plan = buildClusterMergePlan(members, { a: [{ key: "contacts", table: "contacts", count: 1, ids: ["c1"] }] });
    expect(plan.winnerId).toBe("b"); // more contacts wins the tie
    expect(plan.classification).toBe("review");
    expect(plan.reasons).toContain("divergent_website");
    expect(plan.totalMovedRows).toBe(1);
  });
});
