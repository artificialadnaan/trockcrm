// The write half of the canvassing report: does anything actually RECORD who created a directory row?
//
// The report is only as good as its input, and the input is three service calls. These cases run the real
// createCompany / createProperty / createContact against a real Postgres and assert the column is set —
// and, separately, that the ROUTES take the creator from the session rather than the request body, because
// an author you can set by posting a field is not an author.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { companies, contacts, jobQueue, offices, properties, users } from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import { createCompany } from "../../../src/modules/companies/service.js";
import { createProperty } from "../../../src/modules/properties/service.js";
import { createContact } from "../../../src/modules/contacts/service.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const OFF = U("0ff1");
const ACTOR = U("ac70"); // the signed-in person doing the canvassing
const OTHER = U("07be"); // someone else entirely — never the author of anything below

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec("SET TimeZone='UTC';");
  await pg.exec(// jobQueue: POST /contacts writes a durable domain-event outbox row inside the same transaction.
    tenantSchemaSql("public", [offices, users, companies, contacts, properties, jobQueue]));
  await pg.exec(`
    INSERT INTO public.offices (id, name, slug) VALUES ('${OFF}', 'Dallas', 'dallas');
    INSERT INTO public.users (id, email, display_name, role, office_id, is_active) VALUES
      ('${ACTOR}', 'emccarty@example.com', 'Edward McCarty', 'rep', '${OFF}', true),
      ('${OTHER}', 'other@example.com',    'Someone Else',   'rep', '${OFF}', true);
  `);
  tdb = drizzle(pg);
}, 60_000);

afterAll(async () => {
  await pg?.close?.();
});

async function creatorOf(table: "companies" | "properties" | "contacts", id: string) {
  const result = await tdb.execute(
    sql`SELECT created_by_user_id::text AS creator FROM ${sql.raw(table)} WHERE id = ${id}::uuid`
  );
  return result.rows[0]?.creator ?? null;
}

describe("directory creates record their author", () => {
  it("createCompany stores the creator, and stores it SEPARATELY from the owner", async () => {
    const { company } = await createCompany(tdb, {
      name: "Canvassed Company",
      category: "client",
      // Owner and creator are different people here on purpose. They coincide on a normal interactive
      // create, which is exactly why a test that passed the same id for both would prove nothing.
      ownerUserId: OTHER,
      createdByUserId: ACTOR,
    });

    expect(company).not.toBeNull();
    expect(await creatorOf("companies", company!.id)).toBe(ACTOR);
    expect(company!.ownerId).toBe(OTHER);
  });

  it("createProperty stores the creator — the only authorship a property has", async () => {
    const { company } = await createCompany(
      tdb,
      { name: "Host For Property", category: "client", createdByUserId: ACTOR },
      true
    );
    const property = await createProperty(tdb, {
      companyId: company!.id,
      name: "Tower A",
      address: "100 Main St",
      city: "Dallas",
      state: "TX",
      zip: "75201",
      createdByUserId: ACTOR,
    });

    expect(await creatorOf("properties", property.id)).toBe(ACTOR);
  });

  it("createContact stores the creator separately from the owner", async () => {
    const { contact } = await createContact(
      tdb,
      {
        firstName: "Jane",
        lastName: "Doe",
        category: "property_manager",
        ownerUserId: OTHER,
        createdByUserId: ACTOR,
      },
      true
    );

    expect(await creatorOf("contacts", contact.id)).toBe(ACTOR);
    expect(contact.ownerId).toBe(OTHER);
  });

  // Machine callers (SyncHub ingestion, imports, the demo seed) pass nothing. They must land as NULL so the
  // report reads them as unattributed rather than crediting them to whoever happens to be first in a list.
  it("leaves the creator NULL when a non-interactive caller omits it", async () => {
    const { company } = await createCompany(tdb, { name: "Imported Co", category: "client" }, true);
    expect(await creatorOf("companies", company!.id)).toBeNull();
  });
});

describe("the routes take the author from the SESSION, never the body", () => {
  // A creator that can be set by posting a field is not a creator — anyone could assign their canvassing
  // to someone else, or credit themselves with a colleague's work. These cases post a hostile body.
  async function routeApp(modulePath: string, mount: string) {
    const express = (await import("express")).default;
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.user = { id: ACTOR, email: "emccarty@example.com", role: "rep", displayName: "Edward McCarty", officeId: OFF, activeOfficeId: OFF };
      req.tenantDb = tdb;
      req.commitTransaction = vi.fn().mockResolvedValue(undefined);
      next();
    });
    const mod = await import(modulePath);
    app.use(mount, mod.companyRoutes ?? mod.contactRoutes ?? mod.propertyRoutes);
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(err?.statusCode ?? 500).json({ error: err?.message });
    });
    return app;
  }

  it("POST /companies ignores a createdByUserId in the body", async () => {
    const request = (await import("supertest")).default;
    const app = await routeApp("../../../src/modules/companies/routes.js", "/companies");

    const res = await request(app)
      .post("/companies")
      .send({ name: "Spoofed Co", category: "client", createdByUserId: OTHER, ownerUserId: OTHER, skipDedupCheck: true });

    expect(res.status).toBe(201);
    expect(await creatorOf("companies", res.body.company.id)).toBe(ACTOR);
  });

  it("POST /contacts ignores a createdByUserId in the body", async () => {
    const request = (await import("supertest")).default;
    const app = await routeApp("../../../src/modules/contacts/routes.js", "/contacts");

    const res = await request(app)
      .post("/contacts")
      .send({
        firstName: "Spoofed",
        lastName: "Contact",
        category: "property_manager",
        createdByUserId: OTHER,
        ownerUserId: OTHER,
        skipDedupCheck: true,
      });

    expect(res.status).toBe(201);
    expect(await creatorOf("contacts", res.body.contact.id)).toBe(ACTOR);
  });
});
