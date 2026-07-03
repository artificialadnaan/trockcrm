import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  UUID_DEAL_PATCH_FIELDS,
  stripBlankUuidPatchFields,
} from "../../../src/modules/deals/uuid-patch-coercion.js";

/**
 * RUNTIME GUARD for the deal PATCH route's empty-string uuid hardening.
 *
 * The deal update path writes companyId/propertyId (and the other relationship
 * uuid fields) straight into Postgres `uuid` columns via updateDeal's
 * `if (input.<field> !== undefined) updates.<col> = input.<field>`. An empty
 * (or whitespace-only) string fails the uuid cast (22P02 -> 500). BLUE's #636
 * fixed the form client-side, but any other caller still 500s.
 *
 * This file proves, against a REAL `uuid` column, that:
 *   (1) the hazard is real — writing "" into a uuid column raises 22P02, and
 *   (2) stripBlankUuidPatchFields() removes blank uuid fields so the surviving
 *       partial-PATCH never carries "" to the write, never clears a set value,
 *       and still writes a genuine uuid; non-uuid fields and explicit null are
 *       left untouched (clear-semantics preserved).
 */

// field name -> column name, mirroring the deals schema relationship columns.
const FIELD_TO_COLUMN: Record<string, string> = {
  companyId: "company_id",
  propertyId: "property_id",
  assignedRepId: "assigned_rep_id",
  primaryContactId: "primary_contact_id",
  sourceLeadId: "source_lead_id",
  projectTypeId: "project_type_id",
  regionId: "region_id",
};

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const DEAL = U("d1");
const CO_A = U("c0a");
const PROP = U("9701");

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE deals (
      id uuid PRIMARY KEY, sales_source_user_id uuid,
      name text NOT NULL,
      company_id uuid,
      property_id uuid,
      assigned_rep_id uuid,
      primary_contact_id uuid,
      source_lead_id uuid,
      project_type_id uuid,
      region_id uuid
    );
  `);
});

afterAll(async () => {
  await pg?.close?.();
});

beforeEach(async () => {
  await pg.exec(`DELETE FROM deals;`);
  // Seed a deal with company_id already SET (so we can prove "" never clears it)
  // and every other uuid relationship column NULL.
  await pg.query(`INSERT INTO deals (id, name, company_id) VALUES ($1, 'Roof One', $2)`, [DEAL, CO_A]);
});

/**
 * Faithfully mirrors updateDeal's write step for the relationship uuid fields:
 * run the body through the production coercion, then build a parameterized
 * UPDATE from whatever uuid fields SURVIVE (only provided fields are written),
 * and execute it against the real uuid columns.
 */
async function applyUuidPatch(body: Record<string, unknown>) {
  const patch = { ...body };
  stripBlankUuidPatchFields(patch);
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const field of UUID_DEAL_PATCH_FIELDS) {
    if (patch[field] !== undefined) {
      params.push(patch[field]);
      sets.push(`${FIELD_TO_COLUMN[field]} = $${params.length}`);
    }
  }
  if (sets.length === 0) return; // nothing provided -> no write (existing behavior)
  params.push(DEAL);
  await pg.query(`UPDATE deals SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
}

async function dealRow() {
  const r = await pg.query<Record<string, string | null>>(
    `SELECT * FROM deals WHERE id = $1`,
    [DEAL]
  );
  return r.rows[0];
}

describe("deal PATCH empty-string uuid hardening (PGlite)", () => {
  it("writing an empty string into a uuid column raises 22P02 — the hazard this guards", async () => {
    await expect(
      pg.query(`UPDATE deals SET company_id = $1 WHERE id = $2`, ["", DEAL])
    ).rejects.toThrow(/invalid input syntax for type uuid|22P02/i);
  });

  it("omits an empty-string companyId, leaving the set value intact (no 500, no clear)", async () => {
    await applyUuidPatch({ companyId: "" });
    expect((await dealRow()).company_id).toBe(CO_A);
  });

  it("omits a whitespace-only uuid value", async () => {
    await applyUuidPatch({ companyId: "   " });
    expect((await dealRow()).company_id).toBe(CO_A);
  });

  it("still writes a genuine uuid", async () => {
    await applyUuidPatch({ propertyId: PROP });
    expect((await dealRow()).property_id).toBe(PROP);
  });

  it("leaves the column unchanged when the field is omitted entirely", async () => {
    await applyUuidPatch({ name: "renamed" });
    expect((await dealRow()).company_id).toBe(CO_A);
  });

  it("writes the valid field and omits the blank one when a PATCH mixes both", async () => {
    await applyUuidPatch({ propertyId: PROP, companyId: "" });
    const row = await dealRow();
    expect(row.property_id).toBe(PROP);
    expect(row.company_id).toBe(CO_A);
  });

  it("strips a blank value for every relationship uuid field, so none reaches the write", async () => {
    const blankAll = Object.fromEntries(UUID_DEAL_PATCH_FIELDS.map((f) => [f, ""]));
    await applyUuidPatch(blankAll); // all blank -> no SET clause -> no write, no throw
    const row = await dealRow();
    expect(row.company_id).toBe(CO_A);
    expect(row.property_id).toBeNull();
    expect(row.assigned_rep_id).toBeNull();
    expect(row.region_id).toBeNull();
  });
});

describe("stripBlankUuidPatchFields", () => {
  it("removes blank uuid fields and reports them, preserving valid ids and non-uuid fields", () => {
    const body: Record<string, unknown> = {
      companyId: "",
      propertyId: PROP,
      name: "", // non-uuid empty string must be preserved (not this fix's concern)
    };
    const stripped = stripBlankUuidPatchFields(body);
    expect(stripped).toEqual(["companyId"]);
    expect(body).toEqual({ propertyId: PROP, name: "" });
  });

  it("leaves an explicit null untouched so existing clear-semantics still apply", () => {
    const body: Record<string, unknown> = { companyId: null, regionId: null };
    const stripped = stripBlankUuidPatchFields(body);
    expect(stripped).toEqual([]);
    expect(body).toEqual({ companyId: null, regionId: null });
  });
});
