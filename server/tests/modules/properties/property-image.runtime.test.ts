import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

/**
 * REAL-SQL runtime coverage (PGlite) for the property cover-photo key writers. `.returning()` lists every
 * column of the drizzle `properties` schema, so the table is created in full. Proves: existence probe, the
 * set writer returns the PREVIOUS keys (for R2 cleanup) and updates the row, and clear nulls both keys.
 */

const T = "office_test";
const COMPANY = "00000000-0000-0000-0000-0000000000c1";
const PROP = "00000000-0000-0000-0000-0000000000a1";
const MISSING = "00000000-0000-0000-0000-0000000000ff";

let pg: PGlite;
let tdb: never;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE SCHEMA ${T};
    CREATE TABLE ${T}.properties (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL,
      name varchar(500) NOT NULL,
      address text, city varchar(255), state varchar(2), zip varchar(10),
      type text, property_type text,
      build_year integer, unit_count integer, floors integer, roof_area integer,
      lat numeric(10,7), lng numeric(10,7),
      last_activity_at timestamptz,
      procore_id text, procore_property_id text,
      companycam_id text, companycam_project_id text, hubspot_property_id text,
      image_r2_key text, image_thumbnail_r2_key text,
      notes text,
      is_test_data boolean NOT NULL DEFAULT false,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    SET search_path TO ${T}, public;
  `);
  await pg.exec(`INSERT INTO ${T}.properties (id, company_id, name) VALUES ('${PROP}', '${COMPANY}', 'Milo at Mountain Park');`);
  tdb = drizzle(pg) as never;
});

afterAll(async () => {
  await pg?.close?.();
});

async function svc() {
  return import("../../../src/modules/properties/property-image-service.js");
}

describe("property image key writers (real SQL)", () => {
  it("propertyExists reflects the row", async () => {
    const { propertyExists } = await svc();
    expect(await propertyExists(tdb, PROP)).toBe(true);
    expect(await propertyExists(tdb, MISSING)).toBe(false);
  });

  it("setPropertyImageKeys stores keys and returns the previous (null) keys on first set", async () => {
    const { setPropertyImageKeys } = await svc();
    const result = await setPropertyImageKeys(tdb, PROP, {
      imageR2Key: "properties/p/cover-1.jpg",
      imageThumbnailR2Key: "properties/p/cover-1_thumb.jpg",
    });
    expect(result).not.toBeNull();
    expect(result!.property.imageR2Key).toBe("properties/p/cover-1.jpg");
    expect(result!.property.imageThumbnailR2Key).toBe("properties/p/cover-1_thumb.jpg");
    expect(result!.previousKeys).toEqual({ imageR2Key: null, imageThumbnailR2Key: null });
  });

  it("a replacement returns the SUPERSEDED keys so the route can clean them from R2", async () => {
    const { setPropertyImageKeys } = await svc();
    const result = await setPropertyImageKeys(tdb, PROP, {
      imageR2Key: "properties/p/cover-2.jpg",
      imageThumbnailR2Key: "properties/p/cover-2_thumb.jpg",
    });
    expect(result!.previousKeys).toEqual({
      imageR2Key: "properties/p/cover-1.jpg",
      imageThumbnailR2Key: "properties/p/cover-1_thumb.jpg",
    });
    expect(result!.property.imageR2Key).toBe("properties/p/cover-2.jpg");
  });

  it("clearPropertyImageKeys nulls both keys and returns the removed keys", async () => {
    const { clearPropertyImageKeys } = await svc();
    const result = await clearPropertyImageKeys(tdb, PROP);
    expect(result!.property.imageR2Key).toBeNull();
    expect(result!.property.imageThumbnailR2Key).toBeNull();
    expect(result!.previousKeys).toEqual({
      imageR2Key: "properties/p/cover-2.jpg",
      imageThumbnailR2Key: "properties/p/cover-2_thumb.jpg",
    });
  });

  it("returns null for a property that does not exist", async () => {
    const { setPropertyImageKeys } = await svc();
    const result = await setPropertyImageKeys(tdb, MISSING, {
      imageR2Key: "x",
      imageThumbnailR2Key: null,
    });
    expect(result).toBeNull();
  });
});
