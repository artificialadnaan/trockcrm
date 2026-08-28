import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deals, fieldResponders, files, offices, users } from "@trock-crm/shared/schema";
import { AppError } from "../../../src/middleware/error-handler.js";
import {
  getCoreWeeklyReportDetail,
  listCoreWeeklyReports,
  requireCoreWeeklyReportDealBinding,
  resolveCoreWeeklyReportDeal,
} from "../../../src/modules/weekly-reports/core-api-service.js";
import {
  decodeCoreWeeklyReportCursor,
  encodeCoreWeeklyReportCursor,
} from "../../../src/modules/weekly-reports/core-api-auth.js";
import { migrationSql } from "../../helpers/migration-sql.js";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";

const U = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
const OFFICE = U("1");
const WON_STAGE = U("2");
const UPLOADER = U("3");
const DEAL = U("10");
const CHANGE_ORDER = U("11");
const OTHER_DEAL = U("12");
const CO_ONLY = U("13");
const AMBIGUOUS_A = U("14");
const AMBIGUOUS_B = U("15");
const DISCREPANT_IDENTITY = U("16");
const PROJECT = U("100");
const OTHER_PROJECT = U("101");
const REPORT_LATEST = U("200");
const REPORT_OLD = U("201");
const REPORT_CORRECTION = U("202");
const REPORT_WITHDRAWN = U("203");
const REPORT_APPROVED = U("204");
const REPORT_PENDING = U("205");
const REPORT_DRAFT = U("206");
const REPORT_NO_SNAPSHOT = U("207");
const REPORT_NO_SENT_AT = U("208");
const OTHER_REPORT = U("209");
const LATE_REPORT = U("210");
const REPORT_UNACCEPTED = U("211");
const REPORT_BOUNCED = U("212");
const REPORT_FAILED = U("213");
const REPORT_LEGACY_PROPERTY = U("214");
const PHOTO = U("300");
const CURSOR_SECRET = "runtime-cursor-secret-with-32-byte-minimum-0001";

let pg: PGlite;
const executedServiceSql: string[] = [];

const db = {
  query: async (text: string, params?: unknown[]) => {
    executedServiceSql.push(text);
    const result = await pg.query(text, params as any[] | undefined);
    return {
      rows: result.rows as any[],
      rowCount: (result as { affectedRows?: number }).affectedRows ?? result.rows.length,
    } as any;
  },
};

const SNAPSHOT = {
  propertyDisplayName: "Frozen Cedar Property",
  clientName: "Frozen Client LLC",
  clientTeam: {
    doc: { name: "Frozen DOC", email: "private@example.com" },
    pm: { name: "Frozen Client PM", email: null },
    rm: { name: null, email: null },
    cm: { name: null, email: null },
  },
  trockTeam: {
    pmUserId: null,
    pmName: "Frozen T Rock PM",
    superUserId: null,
    superName: "Frozen Superintendent",
  },
  schedule: {
    contractDate: "2026-07-08",
    contractDateNote: null,
    projectStartDate: null,
    projectStartDateNote: "TBD Permit",
    projectCompletionDate: null,
    projectCompletionDateNote: "TBD Permit",
    projectedDurationWeeks: 19,
  },
  snapshotVersion: 1,
};

async function expectAppError(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AppError);
  expect((caught as AppError).statusCode).toBe(status);
  expect((caught as AppError).code).toBe(code);
}

async function insertReport(input: {
  id: string;
  projectId?: string;
  dealId?: string;
  weekOf: string;
  version?: number;
  status: "draft" | "pending_review" | "approved" | "sent";
  sentAt?: string | null;
  deliveredAt?: string | null;
  deliveryStatus?: "delayed" | "delivered" | "complained" | "failed" | "bounced" | null;
  snapshot?: Record<string, unknown> | null;
  active?: boolean;
  narrative?: string;
}): Promise<void> {
  const sentAt = input.sentAt ?? null;
  const deliveredAt =
    input.deliveredAt === undefined && input.status === "sent" ? sentAt : input.deliveredAt ?? null;
  await pg.query(
    `INSERT INTO office_dallas.weekly_reports (
       id, client_submission_id, weekly_report_project_id, deal_id, week_of, version, status,
       work_completed, next_week_look_ahead, issues_concerns, completion_percent,
       weather_delay_days, remaining_weeks, projected_duration_weeks, snapshot,
       reviewed_at, sent_at, send_delivered_at, send_delivery_status,
       send_delivery_status_at, send_request, send_delivery_detail, is_active
     ) VALUES (
       $1::uuid, gen_random_uuid(), $2::uuid, $3::uuid, $4::date, $5, $6::varchar,
       $7, 'Safe next-week plan', 'Safe issue note', 37.50,
       2, 11, 19, $8::jsonb,
       CASE WHEN $6::text IN ('approved','sent') THEN '2026-08-01T12:00:00Z'::timestamptz END,
       $9::timestamptz,
       $10::timestamptz,
       $11::text,
       CASE WHEN $11::text IS NOT NULL THEN COALESCE($10::timestamptz, $9::timestamptz) END,
       '{"publicUrl":"https://crm.invalid/wr/raw-secret-token"}'::jsonb,
       '{"providerPayload":"must-not-leak"}'::jsonb,
       $12
     )`,
    [
      input.id,
      input.projectId ?? PROJECT,
      input.dealId ?? DEAL,
      input.weekOf,
      input.version ?? 1,
      input.status,
      input.narrative ?? `Safe narrative for ${input.id}`,
      input.snapshot === null
        ? null
        : JSON.stringify(input.snapshot === undefined ? SNAPSHOT : input.snapshot),
      sentAt,
      deliveredAt,
      input.deliveryStatus ?? null,
      input.active ?? true,
    ],
  );
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec("CREATE SCHEMA office_dallas;");
  await pg.exec(tenantSchemaSql("public", [offices, users]));
  await pg.exec(tenantSchemaSql("office_dallas", [deals, fieldResponders, files]));
  await pg.exec("CREATE TABLE IF NOT EXISTS public.pipeline_stage_config (id uuid PRIMARY KEY, slug text);");
  await pg.exec(migrationSql("0222_weekly_reports"));
  await pg.exec(migrationSql("0223_weekly_report_pauses"));
  await pg.exec(migrationSql("0224_weekly_reports_pdf_content_generation"));
  await pg.exec(migrationSql("0226_weekly_report_send"));
  await pg.exec(migrationSql("0227_weekly_report_delivery_events"));
  await pg.exec(migrationSql("0228_weekly_report_project_roster_link"));
  await pg.exec(migrationSql("0229_weekly_report_rep_escalation_kind"));
  await pg.exec(migrationSql("0230_weekly_reports_carried_from"));
  await pg.exec(`
    INSERT INTO public.offices (id, name, slug) VALUES ('${OFFICE}', 'Dallas', 'dallas');
    INSERT INTO public.users (id, display_name, email, role, office_id)
    VALUES ('${UPLOADER}', 'Fixture Uploader', 'fixture-uploader@example.com', 'admin', '${OFFICE}');
    INSERT INTO public.pipeline_stage_config (id, slug) VALUES ('${WON_STAGE}', 'closed_won');
    SET search_path TO office_dallas, public;
  `);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  executedServiceSql.length = 0;
  await pg.exec(`
    DELETE FROM office_dallas.weekly_report_photos;
    DELETE FROM office_dallas.weekly_reports;
    DELETE FROM office_dallas.weekly_report_projects;
    DELETE FROM office_dallas.files;
    DELETE FROM office_dallas.deals;

    INSERT INTO office_dallas.deals
      (id, name, deal_number, stage_id, project_number, bid_board_project_number, is_change_order, parent_deal_id)
    VALUES
      ('${DEAL}', 'Live deal name must not replace snapshot', 'DFW-1-12345-AA', '${WON_STAGE}', 'DFW-1-12345-AA', null, false, null),
      ('${CHANGE_ORDER}', 'CO child', 'DFW-1-12345-AA-CO1', '${WON_STAGE}', 'DFW-1-12345-AA', null, true, '${DEAL}'),
      ('${OTHER_DEAL}', 'Other client project', 'DFW-1-54321-BB', '${WON_STAGE}', 'DFW-1-54321-BB', null, false, null),
      ('${CO_ONLY}', 'Orphaned CO-only identity', 'ATL-1-99999-ZZ-CO1', '${WON_STAGE}', 'ATL-1-99999-ZZ', null, true, '${DEAL}'),
      ('${AMBIGUOUS_A}', 'Ambiguous A', 'DFW-1-00001-AA', '${WON_STAGE}', 'DFW-1-00001-AA', null, false, null),
      ('${AMBIGUOUS_B}', 'Ambiguous B', 'DFW-1-00002-BB', '${WON_STAGE}', 'DFW-1-00002-BB', 'dfw-1-00001-aa', false, null),
      ('${DISCREPANT_IDENTITY}', 'Discrepant identity', 'DFW-1-STALE-AA', '${WON_STAGE}', 'DFW-1-CURRENT-AA', null, false, null);

    INSERT INTO office_dallas.weekly_report_projects
      (id, deal_id, property_display_name, client_name, cadence_weekday, cadence_start_date)
    VALUES
      ('${PROJECT}', '${DEAL}', 'Live property must not replace snapshot', 'Live client', 4, '2026-07-01'),
      ('${OTHER_PROJECT}', '${OTHER_DEAL}', 'Other property', 'Other client', 4, '2026-07-01');

    INSERT INTO office_dallas.files (
      id, category, display_name, system_filename, original_filename, mime_type, file_size_bytes,
      file_extension, r2_key, r2_bucket, external_url, external_thumbnail_url, deal_id, description,
      uploaded_by
    ) VALUES (
      '${PHOTO}', 'photo', 'progress.jpg', 'progress.jpg', 'progress.jpg', 'image/jpeg', 100,
      'jpg', 'office_dallas/deals/DFW-1-12345-AA/private-object-key.jpg', 'private-bucket',
      'https://provider.invalid/raw-photo', 'https://provider.invalid/raw-thumb', '${DEAL}',
      'internal original description', '${UPLOADER}'
    );
  `);

  await insertReport({
    id: REPORT_LATEST,
    weekOf: "2026-08-27",
    status: "sent",
    sentAt: "2026-08-27T18:00:00Z",
    narrative: "Latest safe narrative",
  });
  await insertReport({
    id: REPORT_OLD,
    weekOf: "2026-08-20",
    version: 1,
    status: "sent",
    sentAt: "2026-08-20T17:00:00Z",
    narrative: "Superseded safe narrative",
  });
  await insertReport({
    id: REPORT_CORRECTION,
    weekOf: "2026-08-20",
    version: 2,
    status: "sent",
    sentAt: "2026-08-21T17:00:00Z",
    deliveryStatus: "delivered",
    narrative: "Correction safe narrative",
  });
  await pg.query(
    "UPDATE office_dallas.weekly_reports SET superseded_by_id = $2::uuid WHERE id = $1::uuid",
    [REPORT_OLD, REPORT_CORRECTION],
  );
  await insertReport({
    id: REPORT_WITHDRAWN,
    weekOf: "2026-08-13",
    status: "sent",
    sentAt: "2026-08-13T17:00:00Z",
    active: false,
    narrative: "Withdrawn retained narrative must never leave",
  });
  await insertReport({ id: REPORT_APPROVED, weekOf: "2026-09-03", status: "approved" });
  await insertReport({ id: REPORT_PENDING, weekOf: "2026-09-10", status: "pending_review" });
  await insertReport({ id: REPORT_DRAFT, weekOf: "2026-09-17", status: "draft" });
  await insertReport({
    id: REPORT_NO_SNAPSHOT,
    weekOf: "2026-08-06",
    status: "sent",
    sentAt: "2026-08-06T17:00:00Z",
    snapshot: null,
  });
  await insertReport({
    id: REPORT_NO_SENT_AT,
    weekOf: "2026-07-30",
    status: "sent",
    sentAt: null,
  });
  await insertReport({
    id: REPORT_UNACCEPTED,
    weekOf: "2026-07-23",
    status: "sent",
    sentAt: "2026-07-23T17:00:00Z",
    deliveredAt: null,
    narrative: "Queued but never accepted narrative must never leave",
  });
  await insertReport({
    id: REPORT_BOUNCED,
    weekOf: "2026-07-16",
    status: "sent",
    sentAt: "2026-07-16T17:00:00Z",
    deliveredAt: "2026-07-16T17:01:00Z",
    deliveryStatus: "bounced",
    narrative: "Bounced narrative must never leave",
  });
  await insertReport({
    id: REPORT_FAILED,
    weekOf: "2026-07-09",
    status: "sent",
    sentAt: "2026-07-09T17:00:00Z",
    deliveredAt: "2026-07-09T17:01:00Z",
    deliveryStatus: "failed",
    narrative: "Provider-failed narrative must never leave",
  });
  await insertReport({
    id: OTHER_REPORT,
    projectId: OTHER_PROJECT,
    dealId: OTHER_DEAL,
    weekOf: "2026-08-27",
    status: "sent",
    sentAt: "2026-08-27T18:00:00Z",
    narrative: "Other deal secret narrative",
  });
  await pg.query(
    `INSERT INTO office_dallas.weekly_report_photos
       (weekly_report_id, file_id, caption, sort_order)
     VALUES ($1::uuid, $2::uuid, 'Client-safe balcony caption', 7)`,
    [REPORT_LATEST, PHOTO],
  );
});

describe("Core weekly-report deal resolution", () => {
  it("uses the Bid Board canonicalizer and resolves the root while ignoring its CO child", async () => {
    const result = await resolveCoreWeeklyReportDeal(db, " \tDFW–1–12345–AA\u00a0");
    expect(result).toEqual({ id: DEAL, canonicalProjectNumber: "dfw-1-12345-aa" });
  });

  it("fails closed for a change-order-only match and for cross-column parent ambiguity", async () => {
    await expectAppError(
      resolveCoreWeeklyReportDeal(db, "ATL-1-99999-ZZ"),
      404,
      "core_weekly_report_deal_not_found",
    );
    await expectAppError(
      resolveCoreWeeklyReportDeal(db, "DFW-1-00001-AA"),
      409,
      "core_weekly_report_deal_ambiguous",
    );
    await expectAppError(
      resolveCoreWeeklyReportDeal(db, "DFW-1-STALE-AA"),
      409,
      "core_weekly_report_deal_identity_conflict",
    );
    await expect(resolveCoreWeeklyReportDeal(db, "DFW-1-CURRENT-AA")).resolves.toEqual({
      id: DISCREPANT_IDENTITY,
      canonicalProjectNumber: "dfw-1-current-aa",
    });
  });

  it("revalidates the exact stable id + current canonical-number pair", async () => {
    await expect(
      requireCoreWeeklyReportDealBinding(db, DEAL, "dfw-1-12345-aa"),
    ).resolves.toEqual({ id: DEAL, canonicalProjectNumber: "dfw-1-12345-aa" });
    expect(executedServiceSql.some((sql) => sql.includes("FOR SHARE OF d"))).toBe(true);
    await expectAppError(
      requireCoreWeeklyReportDealBinding(db, DEAL, "dfw-1-stale"),
      409,
      "core_weekly_report_deal_binding_changed",
    );
    await expectAppError(
      requireCoreWeeklyReportDealBinding(db, CHANGE_ORDER, "dfw-1-12345-aa"),
      404,
      "core_weekly_report_deal_not_found",
    );
  });
});

describe("Core weekly-report sent-history list", () => {
  it("publishes provider-accepted snapshots with null/delivered verdicts, but excludes known failures", async () => {
    const page = await listCoreWeeklyReports(db, {
      dealId: DEAL,
      limit: 100,
      asOf: "2026-08-28T00:00:00.000Z",
    });
    expect(page.items.map((row) => row.id)).toEqual([
      REPORT_LATEST,
      REPORT_CORRECTION,
      REPORT_OLD,
      REPORT_WITHDRAWN,
    ]);
    expect(page.items.map((row) => row.lifecycleState)).toEqual([
      "latest",
      "latest",
      "superseded",
      "withdrawn",
    ]);
    expect(new Set(page.items.map((row) => row.publicationStatus))).toEqual(new Set(["sent"]));
    expect(page.items.map((row) => row.id)).not.toContain(REPORT_APPROVED);
    expect(page.items.map((row) => row.id)).not.toContain(REPORT_NO_SNAPSHOT);
    expect(page.items.map((row) => row.id)).not.toContain(REPORT_NO_SENT_AT);
    expect(page.items.map((row) => row.id)).not.toContain(REPORT_UNACCEPTED);
    expect(page.items.map((row) => row.id)).not.toContain(REPORT_BOUNCED);
    expect(page.items.map((row) => row.id)).not.toContain(REPORT_FAILED);
    expect(page.items.map((row) => row.id)).not.toContain(OTHER_REPORT);
    expect(page.items.find((row) => row.id === REPORT_LATEST)?.sendAcceptedAt).toBe(
      "2026-08-27T18:00:00.000Z",
    );
    // REPORT_LATEST has no webhook verdict (the legacy/ordinary accepted state); the correction has an
    // explicit `delivered` verdict. Both satisfy the established publication gate.
    expect(page.items.map((row) => row.id)).toContain(REPORT_LATEST);
    expect(page.items.map((row) => row.id)).toContain(REPORT_CORRECTION);
  });

  it("keyset-pages without duplicates and keeps sends after the as-of boundary out", async () => {
    const asOf = "2026-08-28T00:00:00.000Z";
    const first = await listCoreWeeklyReports(db, { dealId: DEAL, limit: 2, asOf });
    expect(first.hasMore).toBe(true);
    expect(first.last).not.toBeNull();
    const encoded = encodeCoreWeeklyReportCursor(
      {
        version: 1,
        officeSlug: "dallas",
        dealId: DEAL,
        canonicalProjectNumber: "dfw-1-12345-aa",
        limit: 2,
        asOf,
        issuedAt: asOf,
        expiresAt: "2026-08-28T00:15:00.000Z",
        weekOf: first.last!.weekOf,
        reportVersion: first.last!.reportVersion,
        reportId: first.last!.reportId,
      },
      CURSOR_SECRET,
    );

    await insertReport({
      id: LATE_REPORT,
      weekOf: "2026-09-24",
      status: "sent",
      sentAt: "2026-08-27T23:00:00Z",
      deliveredAt: "2026-08-29T00:00:00Z",
    });
    await pg.query(
      `UPDATE office_dallas.weekly_reports
          SET send_delivery_status = 'bounced',
              send_delivery_status_at = '2026-08-29T00:01:00Z'::timestamptz
        WHERE id = $1::uuid`,
      [REPORT_OLD],
    );
    const cursor = decodeCoreWeeklyReportCursor(encoded, [CURSOR_SECRET], Date.parse(asOf));
    expect(cursor).not.toBeNull();
    const second = await listCoreWeeklyReports(db, {
      dealId: DEAL,
      limit: 2,
      asOf: cursor!.asOf,
      after: {
        weekOf: cursor!.weekOf,
        reportVersion: cursor!.reportVersion,
        reportId: cursor!.reportId,
      },
    });
    expect([...first.items, ...second.items].map((row) => row.id)).toEqual([
      REPORT_LATEST,
      REPORT_CORRECTION,
      REPORT_OLD,
      REPORT_WITHDRAWN,
    ]);
    expect(second.items.map((row) => row.id)).not.toContain(LATE_REPORT);
    // The bounce was dated after the first page's snapshot boundary. It is excluded from fresh walks and
    // from detail immediately, but it cannot reshuffle the metadata positions within this signed walk.
    expect(second.items.map((row) => row.id)).toContain(REPORT_OLD);

    const fresh = await listCoreWeeklyReports(db, {
      dealId: DEAL,
      limit: 100,
      asOf: "2026-08-30T00:00:00.000Z",
    });
    expect(fresh.items.map((row) => row.id)).not.toContain(REPORT_OLD);
    expect(fresh.items.map((row) => row.id)).toContain(LATE_REPORT);
    await expectAppError(
      getCoreWeeklyReportDetail(db, { dealId: DEAL, reportId: REPORT_OLD }),
      404,
      "core_weekly_report_not_found",
    );
  });

  it("does not let a known-failed correction supersede the preceding eligible version", async () => {
    await pg.query(
      `UPDATE office_dallas.weekly_reports
          SET send_delivery_status = 'bounced',
              send_delivery_status_at = '2026-08-21T17:05:00Z'::timestamptz
        WHERE id = $1::uuid`,
      [REPORT_CORRECTION],
    );
    const page = await listCoreWeeklyReports(db, {
      dealId: DEAL,
      limit: 100,
      asOf: "2026-08-28T00:00:00.000Z",
    });
    expect(page.items.map((row) => row.id)).not.toContain(REPORT_CORRECTION);
    expect(page.items.find((row) => row.id === REPORT_OLD)).toMatchObject({
      lifecycleState: "latest",
      supersededByReportId: null,
    });
  });
});

describe("Core weekly-report detail isolation and redaction", () => {
  it("derives content from the frozen sent view after live project data changes", async () => {
    await pg.exec(`
      UPDATE office_dallas.weekly_report_projects
         SET property_display_name = 'Changed live property', client_name = 'Changed live client'
       WHERE id = '${PROJECT}';
      UPDATE office_dallas.deals SET name = 'Changed live deal' WHERE id = '${DEAL}';
    `);
    const detail = await getCoreWeeklyReportDetail(db, {
      dealId: DEAL,
      reportId: REPORT_LATEST,
    });
    expect(executedServiceSql.some((sql) => sql.includes("FOR SHARE OF wr"))).toBe(true);
    expect(detail.content.propertyName).toBe("Frozen Cedar Property");
    expect(detail.content.clientName).toBe("Frozen Client LLC");
    expect(detail.content.trockTeam[0]).toEqual({ label: "PM", name: "Frozen T Rock PM" });
    expect(detail.content.schedule.projectStartDate).toBe("TBD Permit");
    expect(detail.content.photos).toEqual([
      { fileId: PHOTO, caption: "Client-safe balcony caption", sortOrder: 0 },
    ]);
  });

  it("nulls a legacy live deal-name fallback instead of mislabeling it as frozen content", async () => {
    await insertReport({
      id: REPORT_LEGACY_PROPERTY,
      weekOf: "2026-07-02",
      status: "sent",
      sentAt: "2026-07-02T17:00:00Z",
      snapshot: { ...SNAPSHOT, propertyDisplayName: null },
      narrative: "Legacy snapshot remains readable",
    });
    await pg.exec(`UPDATE office_dallas.deals SET name = 'Sensitive current deal rename' WHERE id = '${DEAL}'`);

    const detail = await getCoreWeeklyReportDetail(db, {
      dealId: DEAL,
      reportId: REPORT_LEGACY_PROPERTY,
    });
    expect(detail.content.propertyName).toBeNull();
    expect(detail.content.workCompleted).toBe("Legacy snapshot remains readable");
    expect(JSON.stringify(detail)).not.toContain("Sensitive current deal rename");
  });

  it("does not serialize storage locators, public-link state, provider payloads or internal photo fields", async () => {
    const json = JSON.stringify(
      await getCoreWeeklyReportDetail(db, { dealId: DEAL, reportId: REPORT_LATEST }),
    );
    for (const forbidden of [
      "private-object-key",
      "private-bucket",
      "provider.invalid",
      "raw-secret-token",
      "providerPayload",
      "internal original description",
      "pdfR2Key",
      "externalUrl",
      "sendRequest",
      "sendDeliveryDetail",
    ]) {
      expect(json).not.toContain(forbidden);
    }
  });

  it("never returns other-deal, approved-only, non-snapshot or withdrawn narrative content", async () => {
    await expectAppError(
      getCoreWeeklyReportDetail(db, { dealId: DEAL, reportId: OTHER_REPORT }),
      404,
      "core_weekly_report_not_found",
    );
    await expectAppError(
      getCoreWeeklyReportDetail(db, { dealId: DEAL, reportId: REPORT_APPROVED }),
      404,
      "core_weekly_report_not_found",
    );
    await expectAppError(
      getCoreWeeklyReportDetail(db, { dealId: DEAL, reportId: REPORT_NO_SNAPSHOT }),
      404,
      "core_weekly_report_not_found",
    );
    await expectAppError(
      getCoreWeeklyReportDetail(db, { dealId: DEAL, reportId: REPORT_UNACCEPTED }),
      404,
      "core_weekly_report_not_found",
    );
    await expectAppError(
      getCoreWeeklyReportDetail(db, { dealId: DEAL, reportId: REPORT_BOUNCED }),
      404,
      "core_weekly_report_not_found",
    );
    await expectAppError(
      getCoreWeeklyReportDetail(db, { dealId: DEAL, reportId: REPORT_FAILED }),
      404,
      "core_weekly_report_not_found",
    );
    await expectAppError(
      getCoreWeeklyReportDetail(db, { dealId: DEAL, reportId: REPORT_WITHDRAWN }),
      410,
      "core_weekly_report_withdrawn",
    );
  });
});
