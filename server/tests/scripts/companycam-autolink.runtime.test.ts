import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importPhoto, loadDeals } from "../../../scripts/companycam-import";
import type { CCPhoto } from "../../src/modules/companycam/client.js";

/**
 * Real-SQL guard for the auto-link seed (B):
 *  - import.loadDeals excludes on-hold (COALESCE(on_hold,false)=false) AND inactive deals, so on-hold
 *    deals are never auto-link candidates;
 *  - importPhoto is idempotent — a re-run imports nothing and leaves exactly one file + one ledger row
 *    (the files.companycam_photo_id check + the companycam_import_state unique index).
 * Runs in reference mode (R2 unconfigured) so there is no download/upload/network.
 */

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const DEAL = U("dea1");
const USER = U("0521");

let db: PGlite;

beforeAll(async () => {
  // Force reference mode (no R2 download/upload) regardless of ambient env.
  delete process.env.R2_ACCOUNT_ID;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;

  db = new PGlite();
  await db.exec(`
    CREATE SCHEMA office_dallas;
    CREATE TABLE office_dallas.deals (
      id text PRIMARY KEY, name text, deal_number text, project_number text,
      companycam_project_id text, on_hold boolean, is_active boolean NOT NULL DEFAULT true
    );
    INSERT INTO office_dallas.deals (id, name, deal_number, on_hold, is_active) VALUES
      ('d-active',   'Active',    'A-1', false, true),
      ('d-onhold',   'On Hold',   'A-2', true,  true),
      ('d-nullhold', 'Null Hold', 'A-3', NULL,  true),
      ('d-inactive', 'Inactive',  'A-4', false, false);
    CREATE TABLE office_dallas.files (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      category text, subcategory text, folder_path text, tags text[], display_name text,
      system_filename text, original_filename text, mime_type text, file_size_bytes bigint,
      file_extension text, r2_key text UNIQUE, r2_bucket text, external_url text,
      external_thumbnail_url text, companycam_photo_id text, deal_id uuid, description text,
      notes text, taken_at timestamptz, geo_lat text, geo_lng text, uploaded_by uuid,
      is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE office_dallas.file_links (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      file_id uuid, entity_type text, entity_id uuid, created_by uuid,
      created_at timestamptz DEFAULT now(), UNIQUE (file_id, entity_type, entity_id)
    );
    CREATE TABLE office_dallas.companycam_import_state (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      companycam_project_id text, companycam_photo_id text UNIQUE, deal_id uuid,
      status text, import_started_at timestamptz DEFAULT now(), imported_at timestamptz,
      error text, metadata jsonb DEFAULT '{}'::jsonb,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
    );
  `);
});

afterAll(async () => {
  await db?.close();
});

const client = () => ({ query: (sql: string, params?: unknown[]) => db.query(sql, params as any[]) }) as any;

const photo: CCPhoto = {
  id: "ccphoto-1",
  project_id: "cc-1",
  creator_name: "Field Tech",
  coordinates: { lat: 0, lon: 0 },
  status: "active",
  uris: [
    { type: "original", uri: "https://example.test/orig.jpg", url: "https://example.test/orig.jpg" },
    { type: "thumbnail", uri: "https://example.test/thumb.jpg", url: "https://example.test/thumb.jpg" },
  ],
  hash: "abc123",
  captured_at: 1_700_000_000,
  created_at: 1_700_000_000,
  updated_at: 1_700_000_000,
  photo_url: "https://example.test/photo",
  description: null,
};

describe("companycam auto-link seed — real SQL", () => {
  it("loadDeals excludes on-hold (COALESCE) and inactive deals", async () => {
    const deals = await loadDeals(client(), "office_dallas");
    // on-hold and inactive excluded; a NULL on_hold is kept (COALESCE -> false)
    expect(deals.map((d) => d.id).sort()).toEqual(["d-active", "d-nullhold"]);
  });

  it("importPhoto is idempotent — a re-run imports nothing and leaves one file + one ledger row", async () => {
    const args = {
      client: client(),
      tenant: "office_dallas",
      projectId: "cc-1",
      projectName: "Proj",
      dealId: DEAL,
      dealNumber: "A-1",
      photo,
      userId: USER,
      execute: true,
    };
    const first = await importPhoto(args);
    const second = await importPhoto(args);

    expect(first).toEqual({ imported: true, skipped: false });
    expect(second).toEqual({ imported: false, skipped: true });

    const files = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM office_dallas.files WHERE companycam_photo_id = 'ccphoto-1'",
    );
    expect(files.rows[0].n).toBe(1);
    const ledger = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM office_dallas.companycam_import_state WHERE companycam_photo_id = 'ccphoto-1'",
    );
    expect(ledger.rows[0].n).toBe(1);
    const links = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM office_dallas.file_links WHERE entity_id = $1::uuid",
      [DEAL],
    );
    expect(links.rows[0].n).toBe(1);
  });
});
