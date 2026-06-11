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
// READ-ONLY by contract. Cross-office WRITES (photo attach/confirm) are a separately-gated phase and
// must NOT reuse this module without a deal->office resolver re-binding search_path + R2 key + job
// office — see the Phase 2b plan.

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
export async function resolveOfficeForId(kind: "deal" | "lead" | "file", id: string): Promise<FieldOffice | null> {
  // `table` is a fixed internal literal (never user input); `id` is parameterized.
  const table = sql.identifier(kind === "deal" ? "deals" : kind === "lead" ? "leads" : "files");
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
  kind: "deal" | "lead" | "file",
  id: string,
  run: (officeDb: FieldTenantDb, office: FieldOffice) => Promise<T>,
  notFoundMessage: string,
): Promise<{ value: T; office: FieldOffice }> {
  const office = await resolveOfficeForId(kind, id);
  if (!office) throw new AppError(404, notFoundMessage);
  const value = await runInOffice(office, (officeDb) => run(officeDb, office));
  return { value, office };
}
