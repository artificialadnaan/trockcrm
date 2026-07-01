// Field-only cross-office fan-out.
//
// The field (T-Rock Cam) surface is office-AGNOSTIC: every field user can find and view EVERY project
// across ALL active offices. The CRM/admin/director surfaces keep their single-office model — this
// module is used ONLY by the field routes and deliberately does NOT touch the shared tenantMiddleware
// (which pins one office per request). It mirrors the established cross-office precedent in
// modules/search/service.ts (crossOfficeSearch): one fresh pooled connection per office with a
// session-level search_path, run in parallel via Promise.allSettled so one office failing degrades
// gracefully instead of failing the whole read.
//
// Cross-office WRITES (Phase 2b) live at the bottom of this file, gated behind
// FIELD_CROSS_OFFICE_WRITES_ENABLED and built on the SAME deal->office resolver: they re-bind
// search_path + R2 key + job office to the DEAL's office. See the Phase 2b build doc.

import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "@trock-crm/shared/schema";
import { pool } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";

export type FieldOffice = { id: string; slug: string };
export type FieldTenantDb = NodePgDatabase<typeof schema>;

/** The office stamp attached to every cross-office result, for disambiguation (dealNumber/name are per-schema unique). */
export type OfficeTag = { officeSlug: string; officeId: string };
export function officeTag(office: FieldOffice): OfficeTag {
  return { officeSlug: office.slug, officeId: office.id };
}

export type FanOutOutcome<T> = {
  /** Per-office successful results, paired with the office they came from (for tagging/disambiguation). */
  results: Array<{ office: FieldOffice; value: T }>;
  /** Offices whose query failed — surfaced so the caller can report degraded coverage, not silently drop. */
  failures: Array<{ office: FieldOffice; error: string }>;
};

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * Pure orchestration: run `perOffice` for every office in parallel; a thrown office is captured in
 * `failures` while the rest still return in `results`. No DB/connection concerns — unit-testable.
 */
export async function fanOutOffices<T>(
  offices: readonly FieldOffice[],
  perOffice: (office: FieldOffice) => Promise<T>,
): Promise<FanOutOutcome<T>> {
  const settled = await Promise.allSettled(offices.map((office) => perOffice(office)));
  const results: FanOutOutcome<T>["results"] = [];
  const failures: FanOutOutcome<T>["failures"] = [];
  settled.forEach((outcome, index) => {
    const office = offices[index]!;
    if (outcome.status === "fulfilled") results.push({ office, value: outcome.value });
    else failures.push({ office, error: errorMessage(outcome.reason) });
  });
  return { results, failures };
}

/**
 * Pure: pick the office that reported ownership from a fan-out of ownership checks. Returns null when
 * NO office owns the id AND every office answered cleanly. Throws 503 when no office claimed it but one
 * or more checks FAILED — we cannot conclude the record is absent, so we must NOT collapse a degraded
 * owning-office into a misleading 404 (the record may exist in the office that happened to fail).
 */
export function pickResolvedOffice(outcome: FanOutOutcome<boolean>): FieldOffice | null {
  const owner = outcome.results.find((entry) => entry.value)?.office;
  if (owner) return owner;
  if (outcome.failures.length > 0) {
    throw new AppError(503, "Could not determine the record's office — a schema is temporarily unavailable.");
  }
  return null;
}

/**
 * Pure guard for fan-out LIST reads: if there were active offices but EVERY one failed, throw 503
 * instead of returning an empty 200 that's indistinguishable from "no results". An all-office outage
 * must not look like an empty project list.
 */
export function assertFanOutNotFullyDegraded<T>(outcome: FanOutOutcome<T>): FanOutOutcome<T> {
  if (outcome.results.length === 0 && outcome.failures.length > 0) {
    throw new AppError(503, "Projects are temporarily unavailable — every office failed to respond.");
  }
  return outcome;
}

/** All ACTIVE offices. Field is office-agnostic, so this is the full active set — NOT the user's accessible subset. */
export async function listActiveFieldOffices(): Promise<FieldOffice[]> {
  const { rows } = await pool.query<{ id: string; slug: string }>(
    "SELECT id, slug FROM public.offices WHERE is_active = true ORDER BY slug",
  );
  return rows.map((row) => ({ id: row.id, slug: row.slug }));
}

/**
 * Run `run` against ONE office's schema on a fresh pooled connection (session-level
 * search_path = office_<slug>,public), always resetting search_path and releasing the client.
 * Read-only — never used for writes.
 */
export async function runInOffice<T>(office: FieldOffice, run: (officeDb: FieldTenantDb) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("SELECT set_config('search_path', $1, false)", [`office_${office.slug},public`]);
    const officeDb = drizzle(client, { schema });
    return await run(officeDb);
  } finally {
    try {
      await client.query("SELECT set_config('search_path', 'public', false)");
    } catch {
      /* best-effort reset; the client is released regardless */
    }
    client.release();
  }
}

/** Fan out a read across ALL active offices, each on its own connection. One office failing degrades gracefully. */
export async function fanOutActiveOffices<T>(
  run: (officeDb: FieldTenantDb, office: FieldOffice) => Promise<T>,
): Promise<FanOutOutcome<T>> {
  const offices = await listActiveFieldOffices();
  return fanOutOffices(offices, (office) => runInOffice(office, (officeDb) => run(officeDb, office)));
}

/**
 * Resolve which active office owns a `deals`/`files` row id (read-side resolver). Returns null if no
 * active office contains it. The owning office is what a cross-office detail read must query.
 */
export async function resolveOfficeForId(
  kind: "deal" | "lead" | "file" | "scorecard",
  id: string,
): Promise<FieldOffice | null> {
  // `table` is a fixed internal literal (never user input); `id` is parameterized.
  const table = sql.identifier(
    kind === "deal"
      ? "deals"
      : kind === "lead"
        ? "leads"
        : kind === "scorecard"
          ? "field_scorecards"
          : "files",
  );
  const offices = await listActiveFieldOffices();
  const outcome = await fanOutOffices(offices, (office) =>
    runInOffice(office, async (officeDb) => {
      const result = await officeDb.execute(sql`SELECT 1 AS hit FROM ${table} WHERE id = ${id}::uuid LIMIT 1`);
      const rows = (result as { rows?: unknown[] }).rows ?? [];
      return rows.length > 0;
    }),
  );
  // Throws 503 if the owning office may have failed; returns null only when every office cleanly reported "not mine".
  return pickResolvedOffice(outcome);
}

/**
 * Detail-by-id read: resolve the office that owns `id` and run `run` against ONLY that office's
 * schema. Throws 404 if no active office owns it. Read-only — the resolved office is also returned so
 * the handler can stamp the response with which office the record belongs to.
 */
export async function withResolvedOffice<T>(
  kind: "deal" | "lead" | "file" | "scorecard",
  id: string,
  run: (officeDb: FieldTenantDb, office: FieldOffice) => Promise<T>,
  notFoundMessage: string,
): Promise<{ value: T; office: FieldOffice }> {
  const office = await resolveOfficeForId(kind, id);
  if (!office) throw new AppError(404, notFoundMessage);
  const value = await runInOffice(office, (officeDb) => run(officeDb, office));
  return { value, office };
}

// ─── Phase 2b: cross-office WRITES (gated) ───────────────────────────────────────────────────────
// A cross-office WRITE re-binds the deal's office to all three orphan hazards (search_path, R2 key,
// job_queue.office_id). Everything below is OFF unless FIELD_CROSS_OFFICE_WRITES_ENABLED === "true";
// with the flag off the write office is always the uploader's active office (today's single-office
// behavior), so merging this PR changes nothing until the flag is flipped.

/** Cross-office field WRITES master gate. Default OFF — merging the PR does not activate writes. */
export function isFieldCrossOfficeWritesEnabled(): boolean {
  return process.env.FIELD_CROSS_OFFICE_WRITES_ENABLED === "true";
}

export type WriteOfficeSource = { kind: "deal" | "lead"; id: string } | "uploader";

/**
 * Pure decision: where does a field write land? With the flag OFF (or no capture target), the
 * UPLOADER's active office (today's behavior). With the flag ON and a target, the TARGET's office —
 * resolved from the DB, never client-trusted. `opportunityId` resolves as a deal (opportunities are
 * deal records); an explicit `dealId` wins over `opportunityId` if both are present.
 */
export function pickWriteOfficeSource(
  flagEnabled: boolean,
  target: { dealId?: string; leadId?: string; opportunityId?: string },
): WriteOfficeSource {
  if (!flagEnabled) return "uploader";
  const dealLike = target.dealId ?? target.opportunityId;
  if (dealLike) return { kind: "deal", id: dealLike };
  if (target.leadId) return { kind: "lead", id: target.leadId };
  return "uploader";
}

/** Pure: a resolved office is required — null (no active office owns the id) is a hard 404, write nothing. */
export function requireResolvedOffice(office: FieldOffice | null, notFoundMessage: string): FieldOffice {
  if (!office) throw new AppError(404, notFoundMessage);
  return office;
}

/** Look up one active office by id (the uploader's active office for the flag-off / unassigned path). */
export async function getFieldOfficeById(officeId: string): Promise<FieldOffice> {
  const { rows } = await pool.query<{ id: string; slug: string }>(
    "SELECT id, slug FROM public.offices WHERE id = $1 AND is_active = true",
    [officeId],
  );
  const row = rows[0];
  if (!row) throw new AppError(404, "Office not found or inactive");
  return { id: row.id, slug: row.slug };
}

/** Resolve the office that owns a write target (deal/lead/file); 404 if none, 503 if a schema was unavailable. */
export async function resolveWriteOffice(
  kind: "deal" | "lead" | "file",
  id: string,
  notFoundMessage: string,
): Promise<FieldOffice> {
  // resolveOfficeForId throws 503 (via pickResolvedOffice) when the owning office may have failed,
  // and returns null only when EVERY office cleanly reported "not mine".
  return requireResolvedOffice(await resolveOfficeForId(kind, id), notFoundMessage);
}

/**
 * Route-facing: the office a field write must run in. Flag-off (or no target) → the uploader's active
 * office; flag-on + target → the target's resolved office. NEVER trusts a client-supplied office id.
 */
export async function resolveFieldWriteOffice(
  uploaderOfficeId: string,
  target: { dealId?: string; leadId?: string; opportunityId?: string },
  notFoundMessage = "Capture target not found",
): Promise<FieldOffice> {
  const source = pickWriteOfficeSource(isFieldCrossOfficeWritesEnabled(), target);
  if (source === "uploader") return getFieldOfficeById(uploaderOfficeId);
  return resolveWriteOffice(source.kind, source.id, notFoundMessage);
}

/**
 * Run `run` inside a TRANSACTION bound to one office's schema, faithfully replicating tenantMiddleware's
 * envelope (BEGIN, statement_timeout, LOCAL search_path, LOCAL app.current_user_id, COMMIT/ROLLBACK).
 * This is the WRITE counterpart of runInOffice and the (a) search_path hazard's closure point — every
 * cross-office write runs through here, bound to the resolved office.
 */
export async function runInOfficeTransaction<T>(
  office: FieldOffice,
  userId: string,
  run: (officeDb: FieldTenantDb, office: FieldOffice) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SELECT set_config('search_path', $1, true)", [`office_${office.slug},public`]);
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
    const officeDb = drizzle(client, { schema });
    const result = await run(officeDb, office);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
      /* best-effort; the client is released regardless */
    });
    throw err;
  } finally {
    client.release();
  }
}
