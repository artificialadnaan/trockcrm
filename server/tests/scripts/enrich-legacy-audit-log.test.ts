import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildBatchSummary,
  buildEntityNameSnapshot,
  buildLegacyAuditEnrichmentPlan,
  buildStatementName,
  enrichLegacyAuditLog,
  listTenantSchemas,
  parseEnrichLegacyAuditLogArgs,
  type LegacyAuditEntityRecord,
  type LegacyAuditLookupContext,
  type LegacyAuditRow,
  type Queryable,
} from "../../../scripts/enrich-legacy-audit-log.ts";

function baseRow(overrides: Partial<LegacyAuditRow> = {}): LegacyAuditRow {
  return {
    id: 101,
    tableName: "deals",
    recordId: "11111111-1111-4111-8111-111111111111",
    action: "update",
    changedBy: null,
    actorName: null,
    actorSystemProcess: null,
    entityNameSnapshot: null,
    fieldChangesJsonb: null,
    createdAt: "2026-05-14T12:00:00.000Z",
    ...overrides,
  };
}

function lookupContext(input: Partial<LegacyAuditLookupContext> = {}): LegacyAuditLookupContext {
  return {
    entity: null,
    actorName: null,
    ...input,
  };
}

class MockQueryable implements Queryable {
  readonly updates: Array<{ id: number; entityNameSnapshot: string | null; actorName: string | null }> = [];
  readonly tenantSchemas: string[];
  readonly auditRows: LegacyAuditRow[];
  readonly entityRows: Record<string, LegacyAuditEntityRecord>;
  readonly actorRows: Record<string, string>;
  readonly queries: string[] = [];
  readonly preparedStatements = new Map<string, string>();
  readonly maxLockedFetches: number | null;
  readonly lockedFetchRowIdsByCall: number[][] | null;
  lockedFetches = 0;

  constructor(options: {
    tenantSchemas?: string[];
    auditRows?: LegacyAuditRow[];
    entityRows?: Record<string, LegacyAuditEntityRecord>;
    actorRows?: Record<string, string>;
    maxLockedFetches?: number | null;
    lockedFetchRowIdsByCall?: number[][] | null;
  } = {}) {
    this.tenantSchemas = options.tenantSchemas ?? ["office_atlanta", "office_dallas"];
    this.auditRows = options.auditRows ?? [];
    this.entityRows = options.entityRows ?? {};
    this.actorRows = options.actorRows ?? {};
    this.maxLockedFetches = options.maxLockedFetches ?? null;
    this.lockedFetchRowIdsByCall = options.lockedFetchRowIdsByCall ?? null;
  }

  async query(input: string | { text: string; values?: unknown[] }, params?: unknown[]) {
    const text = typeof input === "string" ? input : input.text;
    const values = (typeof input === "string" ? params : input.values) ?? [];
    this.queries.push(text);

    if (typeof input !== "string" && "name" in input && typeof input.name === "string") {
      const existingText = this.preparedStatements.get(input.name);
      if (existingText && existingText !== input.text) {
        throw new Error(`Prepared statement collision for ${input.name}`);
      }
      this.preparedStatements.set(input.name, input.text);
    }

    if (text.includes("FROM pg_namespace")) {
      return { rows: this.tenantSchemas.map((nspname) => ({ nspname })) };
    }

    if (text.includes(".audit_log") && text.includes("COUNT(*)::int AS total")) {
      const cutoff = String(values[0] ?? "");
      const total = this.auditRows
        .filter((row) => row.createdAt < cutoff)
        .filter((row) => row.enrichAttemptedAt == null)
        .filter((row) => row.entityNameSnapshot == null)
        .filter((row) => row.actorName == null)
        .filter((row) => row.actorSystemProcess == null)
        .filter((row) => row.fieldChangesJsonb == null).length;
      return { rows: [{ total }] };
    }

    if (text.includes(".audit_log") && text.includes("FOR UPDATE SKIP LOCKED")) {
      this.lockedFetches += 1;
      if (this.maxLockedFetches != null && this.lockedFetches > this.maxLockedFetches) {
        throw new Error("execute loop did not terminate");
      }
      const cutoff = String(values[0] ?? "");
      const batchSize = Number(values[1] ?? this.auditRows.length);
      const eligibleRows = this.auditRows
        .filter((row) => row.createdAt < cutoff)
        .filter((row) => row.enrichAttemptedAt == null)
        .filter((row) => row.entityNameSnapshot == null)
        .filter((row) => row.actorName == null)
        .filter((row) => row.actorSystemProcess == null)
        .filter((row) => row.fieldChangesJsonb == null);
      const requestedIds = this.lockedFetchRowIdsByCall?.[this.lockedFetches - 1] ?? null;
      const filtered = (requestedIds
        ? eligibleRows.filter((row) => requestedIds.includes(row.id))
        : eligibleRows
      ).slice(0, batchSize);
      return { rows: filtered };
    }

    if (text.includes(".audit_log") && text.includes("SELECT") && text.includes("entity_name_snapshot IS NULL")) {
      const afterId = Number(values[0] ?? 0);
      const batchSize = Number(values[1] ?? this.auditRows.length);
      const cutoff = String(values[2] ?? "");
      const filtered = this.auditRows
        .filter((row) => row.id > afterId)
        .filter((row) => row.createdAt < cutoff)
        .filter((row) => row.enrichAttemptedAt == null)
        .filter((row) => row.entityNameSnapshot == null)
        .filter((row) => row.actorName == null)
        .filter((row) => row.actorSystemProcess == null)
        .filter((row) => row.fieldChangesJsonb == null)
        .slice(0, batchSize);
      return { rows: filtered };
    }

    if (text.includes("FROM public.users WHERE id = $1::uuid")) {
      const id = String(values[0] ?? "");
      const displayName = this.actorRows[id];
      return { rows: displayName ? [{ displayName }] : [] };
    }

    if (text.includes(".deals WHERE id = $1::uuid")) {
      const id = String(values[0] ?? "");
      const entity = this.entityRows[`deals:${id}`];
      return { rows: entity ? [{ id, name: entity.name, projectNumber: entity.projectNumber }] : [] };
    }

    if (text.includes(".leads WHERE id = $1::uuid")) {
      const id = String(values[0] ?? "");
      const entity = this.entityRows[`leads:${id}`];
      return { rows: entity ? [{ id, name: entity.name }] : [] };
    }

    if (text.includes(".properties WHERE id = $1::uuid")) {
      const id = String(values[0] ?? "");
      const entity = this.entityRows[`properties:${id}`];
      return {
        rows: entity
          ? [{ id, address: entity.address, city: entity.city, state: entity.state, name: entity.name }]
          : [],
      };
    }

    if (text.includes(".companies WHERE id = $1::uuid")) {
      const id = String(values[0] ?? "");
      const entity = this.entityRows[`companies:${id}`];
      return { rows: entity ? [{ id, name: entity.name }] : [] };
    }

    if (text.includes("SELECT id::text, display_name AS \"displayName\" FROM public.users WHERE id = $1::uuid")) {
      const id = String(values[0] ?? "");
      const displayName = this.actorRows[id];
      return { rows: displayName ? [{ id, displayName }] : [] };
    }

    if (text.includes(".audit_log") && text.includes("UPDATE")) {
      const targetId = Number(values[2]);
      const targetIndex = this.auditRows.findIndex((row) => row.id === targetId);
      if (targetIndex >= 0) {
        const existing = this.auditRows[targetIndex];
        this.auditRows[targetIndex] = {
          ...existing,
          entityNameSnapshot: existing.entityNameSnapshot ?? ((values[0] as string | null) ?? null),
          actorName: existing.actorName ?? ((values[1] as string | null) ?? null),
          enrichAttemptedAt: existing.enrichAttemptedAt ?? "2026-05-15T16:30:00.000Z",
        };
      }
      this.updates.push({
        entityNameSnapshot: (values[0] as string | null) ?? null,
        actorName: (values[1] as string | null) ?? null,
        id: targetId,
      });
      return { rows: [], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  }
}

describe("entity snapshot formatting", () => {
  it("formats deals with project_number", () => {
    const entity: LegacyAuditEntityRecord = {
      tableName: "deals",
      id: "11111111-1111-4111-8111-111111111111",
      name: "Legacy Roof Replacement",
      projectNumber: "DFW-2-10001-aa",
    };

    expect(buildEntityNameSnapshot(entity)).toBe("Legacy Roof Replacement (DFW-2-10001-aa)");
  });

  it("formats properties from address, then city/state", () => {
    expect(
      buildEntityNameSnapshot({
        tableName: "properties",
        id: "11111111-1111-4111-8111-111111111111",
        address: "123 Main St",
      })
    ).toBe("123 Main St");

    expect(
      buildEntityNameSnapshot({
        tableName: "properties",
        id: "11111111-1111-4111-8111-111111111111",
        city: "Dallas",
        state: "TX",
      })
    ).toBe("Dallas, TX");
  });
});

describe("prepared statement names", () => {
  it("bounds names below the PostgreSQL 63-byte prepared statement limit", () => {
    const longSlug = `office_${"a".repeat(94)}`;
    const bases = [
      "legacy-audit-enrich-deal",
      "legacy-audit-enrich-lead",
      "legacy-audit-enrich-property",
      "legacy-audit-enrich-company",
      "legacy-audit-enrich-user-entity",
      "legacy-audit-enrich-actor",
      "legacy-audit-enrich-update",
    ];

    for (const base of bases) {
      expect(buildStatementName(longSlug, base).length).toBeLessThanOrEqual(63);
    }
  });

  it("scopes names deterministically by schema hash", () => {
    const base = "legacy-audit-enrich-deal";

    expect(buildStatementName("office_a", base)).not.toBe(buildStatementName("office_b", base));
    expect(buildStatementName("office_dallas", base)).toBe(buildStatementName("office_dallas", base));
  });

  it("does not collide for long slugs with the same first 63 characters", () => {
    const sharedPrefix = `office_${"a".repeat(94)}`;
    const first = buildStatementName(`${sharedPrefix}x`, "legacy-audit-enrich-deal");
    const second = buildStatementName(`${sharedPrefix}y`, "legacy-audit-enrich-deal");

    expect(first.slice(0, 63)).not.toBe(second.slice(0, 63));
  });
});

describe("audit log enrichment migration replay", () => {
  const migrationPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../migrations/0121_audit_log_enrich_attempted_at.sql"
  );
  const migrationSql = readFileSync(migrationPath, "utf-8");

  it("contains a tenant schema replay block using the office_dallas placeholder", () => {
    expect(migrationSql).toContain("-- TENANT_SCHEMA_START");
    expect(migrationSql).toContain("-- TENANT_SCHEMA_END");
    expect(migrationSql).toContain("ALTER TABLE office_dallas.audit_log");
  });

  it("keeps the replay block idempotent for new tenant provisioning", () => {
    const start = migrationSql.indexOf("-- TENANT_SCHEMA_START");
    const end = migrationSql.indexOf("-- TENANT_SCHEMA_END");
    const replayBlock = migrationSql.slice(start, end);

    expect(replayBlock).toContain("ADD COLUMN IF NOT EXISTS enrich_attempted_at");
    expect(replayBlock).toContain("CREATE INDEX IF NOT EXISTS audit_log_enrich_attempted_at_idx");
    expect(replayBlock).toContain("WHERE enrich_attempted_at IS NULL");
  });

  it("creates the supporting partial index for existing tenant schemas", () => {
    const replayStart = migrationSql.indexOf("-- TENANT_SCHEMA_START");
    const existingTenantBlock = migrationSql.slice(0, replayStart);

    expect(existingTenantBlock).toContain("CREATE INDEX IF NOT EXISTS audit_log_enrich_attempted_at_idx");
    expect(existingTenantBlock).toContain("ON %I.audit_log (enrich_attempted_at)");
    expect(existingTenantBlock).toContain("WHERE enrich_attempted_at IS NULL");
  });
});

describe("legacy enrichment planning", () => {
  it("enriches an existing deal row with current snapshot", async () => {
    const plan = await buildLegacyAuditEnrichmentPlan(
      baseRow(),
      lookupContext({
        entity: {
          tableName: "deals",
          id: "11111111-1111-4111-8111-111111111111",
          name: "Legacy Roof Replacement",
          projectNumber: "DFW-2-10001-aa",
        },
      })
    );

    expect(plan.update).toBe(true);
    expect(plan.entityNameSnapshot).toBe("Legacy Roof Replacement (DFW-2-10001-aa)");
    expect(plan.actorName).toBeNull();
  });

  it("uses deleted fallback labels for missing deals", async () => {
    const plan = await buildLegacyAuditEnrichmentPlan(baseRow(), lookupContext());

    expect(plan.update).toBe(true);
    expect(plan.entityNameSnapshot).toBe("[Deleted Deal 11111111]");
    expect(plan.entityResolution).toBe("deleted_fallback");
  });

  it("enriches actor_name from changed_by when user exists", async () => {
    const plan = await buildLegacyAuditEnrichmentPlan(
      baseRow({ tableName: "users", changedBy: "22222222-2222-4222-8222-222222222222" }),
      lookupContext({
        entity: {
          tableName: "users",
          id: "11111111-1111-4111-8111-111111111111",
          displayName: "Alex Admin",
        },
        actorName: "Morgan Sales",
      })
    );

    expect(plan.update).toBe(true);
    expect(plan.actorName).toBe("Morgan Sales");
    expect(plan.entityNameSnapshot).toBe("Alex Admin");
  });

  it("skips metadata tables", async () => {
    const plan = await buildLegacyAuditEnrichmentPlan(baseRow({ tableName: "office_settings" }), lookupContext());

    expect(plan.update).toBe(false);
    expect(plan.skipReason).toBe("office_metadata");
  });

  it("skips invalid UUID record ids", async () => {
    const plan = await buildLegacyAuditEnrichmentPlan(baseRow({ recordId: "not-a-uuid" }), lookupContext());

    expect(plan.update).toBe(false);
    expect(plan.skipReason).toBe("invalid_record_id");
  });

  it("does not modify rows that already have entity_name_snapshot", async () => {
    const plan = await buildLegacyAuditEnrichmentPlan(
      baseRow({ entityNameSnapshot: "Already Enriched" }),
      lookupContext({
        entity: {
          tableName: "deals",
          id: "11111111-1111-4111-8111-111111111111",
          name: "Should Not Replace",
        },
      })
    );

    expect(plan.update).toBe(false);
    expect(plan.skipReason).toBe("already_enriched");
  });

  it("does not modify Phase 1.5 rich rows", async () => {
    const plan = await buildLegacyAuditEnrichmentPlan(
      baseRow({ actorSystemProcess: "HubSpot Refresh" }),
      lookupContext({
        actorName: "Morgan Sales",
      })
    );

    expect(plan.update).toBe(false);
    expect(plan.skipReason).toBe("not_legacy");
  });

  it("is idempotent across repeated passes", async () => {
    const first = await buildLegacyAuditEnrichmentPlan(
      baseRow({ changedBy: "22222222-2222-4222-8222-222222222222" }),
      lookupContext({
        entity: {
          tableName: "deals",
          id: "11111111-1111-4111-8111-111111111111",
          name: "Legacy Roof Replacement",
        },
        actorName: "Morgan Sales",
      })
    );

    const second = await buildLegacyAuditEnrichmentPlan(
      baseRow({
        entityNameSnapshot: first.entityNameSnapshot,
        actorName: first.actorName,
        changedBy: "22222222-2222-4222-8222-222222222222",
      }),
      lookupContext({
        entity: {
          tableName: "deals",
          id: "11111111-1111-4111-8111-111111111111",
          name: "Legacy Roof Replacement",
        },
        actorName: "Morgan Sales",
      })
    );

    expect(first.update).toBe(true);
    expect(second.update).toBe(false);
    expect(second.skipReason).toBe("already_enriched");
  });
});

describe("batch summaries and arg parsing", () => {
  it("summarizes enrichments and skips", () => {
    const summary = buildBatchSummary([
      {
        row: baseRow({ tableName: "deals" }),
        update: true,
        entityNameSnapshot: "Legacy Roof Replacement",
        actorName: null,
        entityResolution: "found",
        actorResolution: "missing_actor",
        skipReason: null,
      },
      {
        row: baseRow({ id: 102, tableName: "deals" }),
        update: true,
        entityNameSnapshot: "[Deleted Deal 11111111]",
        actorName: "Morgan Sales",
        entityResolution: "deleted_fallback",
        actorResolution: "found",
        skipReason: null,
      },
      {
        row: baseRow({ id: 103, tableName: "office_settings" }),
        update: false,
        entityNameSnapshot: null,
        actorName: null,
        entityResolution: "skipped",
        actorResolution: "not_applicable",
        skipReason: "office_metadata",
      },
    ]);

    expect(summary.totalRows).toBe(3);
    expect(summary.rowsToUpdate).toBe(2);
    expect(summary.entitySnapshotsSet).toBe(2);
    expect(summary.actorNamesSet).toBe(1);
    expect(summary.deletedFallbacks).toBe(1);
    expect(summary.byTable.deals?.total).toBe(2);
    expect(summary.byTable.deals?.deletedFallbacks).toBe(1);
    expect(summary.skipped.office_metadata).toBe(1);
  });

  it("parses --office and --all modes", () => {
    expect(parseEnrichLegacyAuditLogArgs(["--office=office_dallas", "--dry-run"])).toMatchObject({
      offices: ["office_dallas"],
      dryRun: true,
    });

    expect(parseEnrichLegacyAuditLogArgs(["--all", "--batch-size=250"])).toMatchObject({
      offices: [],
      batchSize: 250,
    });
  });
});

describe("tenant discovery and dry-run execution", () => {
  it("lists tenant schemas with the escaped office_ pattern", async () => {
    const client = new MockQueryable();
    const schemas = await listTenantSchemas(client);

    expect(schemas).toEqual(["office_atlanta", "office_dallas"]);
    expect(client.queries[0]).toMatch(/LIKE 'office\\_%' ESCAPE '\\'/);
  });

  it("runs dry-run without modifying rows and filters to pre-cutoff legacy rows", async () => {
    const changedBy = "22222222-2222-4222-8222-222222222222";
    const client = new MockQueryable({
      auditRows: [
        baseRow({ id: 101, changedBy }),
        baseRow({ id: 102, createdAt: "2026-05-15T00:00:00.000Z" }),
        baseRow({ id: 103, actorSystemProcess: "HubSpot Refresh" }),
      ],
      entityRows: {
        "deals:11111111-1111-4111-8111-111111111111": {
          tableName: "deals",
          id: "11111111-1111-4111-8111-111111111111",
          name: "Legacy Roof Replacement",
          projectNumber: "DFW-2-10001-aa",
        },
      },
      actorRows: {
        [changedBy]: "Morgan Sales",
      },
    });

    const result = await enrichLegacyAuditLog(client, {
      officeName: "office_dallas",
      dryRun: true,
      batchSize: 500,
    });

    expect(result.examinedRows).toBe(1);
    expect(result.rowsToUpdate).toBe(1);
    expect(result.entitySnapshotsSet).toBe(1);
    expect(result.actorNamesSet).toBe(1);
    expect(client.updates).toHaveLength(0);
  });

  it("applies one update per eligible legacy row and remains stable across reruns", async () => {
    const changedBy = "22222222-2222-4222-8222-222222222222";
    const auditRows = [baseRow({ id: 101, changedBy })];
    const client = new MockQueryable({
      auditRows,
      entityRows: {
        "deals:11111111-1111-4111-8111-111111111111": {
          tableName: "deals",
          id: "11111111-1111-4111-8111-111111111111",
          name: "Legacy Roof Replacement",
          projectNumber: "DFW-2-10001-aa",
        },
      },
      actorRows: {
        [changedBy]: "Morgan Sales",
      },
    });

    const first = await enrichLegacyAuditLog(client, {
      officeName: "office_dallas",
      dryRun: false,
      batchSize: 500,
    });

    expect(first.rowsToUpdate).toBe(1);
    expect(client.updates).toHaveLength(1);
    expect(client.queries.some((query) => query.includes("FOR UPDATE SKIP LOCKED"))).toBe(true);

    auditRows[0] = {
      ...auditRows[0],
      entityNameSnapshot: client.updates[0]?.entityNameSnapshot ?? null,
      actorName: client.updates[0]?.actorName ?? null,
    };

    const second = await enrichLegacyAuditLog(client, {
      officeName: "office_dallas",
      dryRun: false,
      batchSize: 500,
    });

    expect(second.rowsToUpdate).toBe(0);
    expect(client.updates).toHaveLength(1);
  });

  it("processes rows skipped by SKIP LOCKED in a later batch", async () => {
    const changedBy = "22222222-2222-4222-8222-222222222222";
    const client = new MockQueryable({
      auditRows: [
        baseRow({ id: 101, changedBy }),
        baseRow({
          id: 102,
          recordId: "33333333-3333-4333-8333-333333333333",
          changedBy,
        }),
      ],
      entityRows: {
        "deals:11111111-1111-4111-8111-111111111111": {
          tableName: "deals",
          id: "11111111-1111-4111-8111-111111111111",
          name: "Legacy Roof Replacement",
          projectNumber: "DFW-2-10001-aa",
        },
        "deals:33333333-3333-4333-8333-333333333333": {
          tableName: "deals",
          id: "33333333-3333-4333-8333-333333333333",
          name: "Second Deal",
          projectNumber: "DFW-2-10002-aa",
        },
      },
      actorRows: {
        [changedBy]: "Morgan Sales",
      },
      lockedFetchRowIdsByCall: [[102], [101]],
      maxLockedFetches: 3,
    });

    const result = await enrichLegacyAuditLog(client, {
      officeName: "office_dallas",
      dryRun: false,
      batchSize: 1,
    });

    expect(result.rowsToUpdate).toBe(2);
    expect(client.updates.map((update) => update.id).sort()).toEqual([101, 102]);
  });

  it("terminates execute mode even when a batch contains unenrichable rows", async () => {
    const client = new MockQueryable({
      auditRows: [
        baseRow({ id: 101, tableName: "audit_log" }),
        baseRow({ id: 102, recordId: "not-a-uuid" }),
      ],
      maxLockedFetches: 2,
    });

    await expect(
      enrichLegacyAuditLog(client, {
        officeName: "office_dallas",
        dryRun: false,
        batchSize: 500,
      })
    ).resolves.toMatchObject({
      examinedRows: 2,
      rowsToUpdate: 0,
    });
  });
});
