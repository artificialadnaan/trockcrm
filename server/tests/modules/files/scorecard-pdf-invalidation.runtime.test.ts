import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { files } from "@trock-crm/shared/schema";
import { invalidateScorecardPdfArtifactsForFile, updateFile } from "../../../src/modules/files/service.js";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";

const FILE = "aaaaaaaa-0000-0000-0000-000000000001";
const OTHER_FILE = "aaaaaaaa-0000-0000-0000-000000000002";
const CARD_1 = "55555555-5555-5555-5555-000000000001";
const CARD_2 = "55555555-5555-5555-5555-000000000002";
const OTHER_CARD = "55555555-5555-5555-5555-000000000003";
const USER = "77777777-7777-7777-7777-777777777777";

let pg: PGlite;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(tenantSchemaSql("public", [files]));
  await pg.exec(`
    CREATE TABLE field_scorecards (
      id uuid PRIMARY KEY,
      pdf_r2_key text,
      pdf_r2_bucket text,
      pdf_generated_at timestamptz,
      pdf_render_version smallint NOT NULL DEFAULT 1,
      updated_at timestamptz NOT NULL DEFAULT NOW()
    );
    CREATE TABLE field_scorecard_photos (
      id uuid PRIMARY KEY,
      scorecard_id uuid NOT NULL,
      file_id uuid NOT NULL
    );
    INSERT INTO field_scorecards
      (id, pdf_r2_key, pdf_r2_bucket, pdf_generated_at, pdf_render_version, updated_at)
    VALUES
      ('${CARD_1}', 'card-1.v2.pdf', 'bucket', NOW(), 2, '2026-07-14T12:00:00Z'),
      ('${CARD_2}', 'card-2.v2.pdf', 'bucket', NOW(), 2, '2026-07-14T12:00:00Z'),
      ('${OTHER_CARD}', 'other.v2.pdf', 'bucket', NOW(), 2, '2026-07-14T12:00:00Z');
    INSERT INTO field_scorecard_photos VALUES
      ('66666666-6666-6666-6666-000000000001', '${CARD_1}', '${FILE}'),
      ('66666666-6666-6666-6666-000000000002', '${CARD_2}', '${FILE}'),
      ('66666666-6666-6666-6666-000000000003', '${OTHER_CARD}', '${OTHER_FILE}');
  `);
  db = drizzle(pg);
  await db.insert(files).values({
    id: FILE,
    category: "photo",
    displayName: "Framing detail",
    systemFilename: "framing-detail.jpg",
    originalFilename: "framing-detail.jpg",
    mimeType: "image/jpeg",
    fileSizeBytes: 1024,
    fileExtension: ".jpg",
    r2Key: "office_test/deals/DFW-1/photos/framing-detail.jpg",
    r2Bucket: "test-bucket",
    description: "Original caption",
    uploadedBy: USER,
  } as never);
});

afterAll(async () => {
  await pg?.close?.();
});

beforeEach(async () => {
  await pg.exec(`
    UPDATE field_scorecards
    SET pdf_r2_key = CASE id
          WHEN '${CARD_1}'::uuid THEN 'card-1.v2.pdf'
          WHEN '${CARD_2}'::uuid THEN 'card-2.v2.pdf'
          ELSE 'other.v2.pdf'
        END,
        pdf_r2_bucket = 'bucket',
        pdf_generated_at = NOW(),
        updated_at = '2026-07-14T12:00:00Z';
    UPDATE files SET description = 'Original caption' WHERE id = '${FILE}'::uuid;
  `);
});

describe("scorecard PDF invalidation on evidence visibility changes", () => {
  it("invalidates every linked snapshot without touching unrelated scorecards", async () => {
    await invalidateScorecardPdfArtifactsForFile(db as never, FILE);

    const result = await pg.query<{
      id: string;
      pdf_r2_key: string | null;
      pdf_r2_bucket: string | null;
      pdf_generated_at: Date | null;
      pdf_render_version: number;
      updated_at: Date;
    }>("SELECT * FROM field_scorecards ORDER BY id");
    const rows = result.rows;
    for (const id of [CARD_1, CARD_2]) {
      expect(rows.find((row) => row.id === id)).toMatchObject({
        pdf_r2_key: null,
        pdf_r2_bucket: null,
        pdf_generated_at: null,
        pdf_render_version: 2,
      });
      expect(new Date(rows.find((row) => row.id === id)!.updated_at).getTime()).toBeGreaterThan(
        Date.parse("2026-07-14T12:00:00Z"),
      );
    }
    expect(rows.find((row) => row.id === OTHER_CARD)).toMatchObject({
      pdf_r2_key: "other.v2.pdf",
      pdf_render_version: 2,
    });
    expect(new Date(rows.find((row) => row.id === OTHER_CARD)!.updated_at).toISOString()).toBe(
      "2026-07-14T12:00:00.000Z",
    );
  });

  it("invalidates linked snapshots when updateFile changes the evidence caption", async () => {
    const updated = await updateFile(db as never, FILE, { description: "Updated framing caption" });
    expect(updated.description).toBe("Updated framing caption");

    const result = await pg.query<{ id: string; pdf_r2_key: string | null; updated_at: Date }>(
      "SELECT id, pdf_r2_key, updated_at FROM field_scorecards ORDER BY id",
    );
    expect(result.rows.find((row) => row.id === CARD_1)?.pdf_r2_key).toBeNull();
    expect(result.rows.find((row) => row.id === CARD_2)?.pdf_r2_key).toBeNull();
    expect(result.rows.find((row) => row.id === OTHER_CARD)?.pdf_r2_key).toBe("other.v2.pdf");
    expect(new Date(result.rows.find((row) => row.id === CARD_1)!.updated_at).getTime()).toBeGreaterThan(
      Date.parse("2026-07-14T12:00:00Z"),
    );
  });

  it("keeps current artifacts when a caption update is a no-op", async () => {
    await updateFile(db as never, FILE, { description: "Original caption" });
    const result = await pg.query<{ id: string; pdf_r2_key: string | null; updated_at: Date }>(
      "SELECT id, pdf_r2_key, updated_at FROM field_scorecards ORDER BY id",
    );
    expect(result.rows.find((row) => row.id === CARD_1)?.pdf_r2_key).toBe("card-1.v2.pdf");
    expect(result.rows.find((row) => row.id === CARD_2)?.pdf_r2_key).toBe("card-2.v2.pdf");
    expect(new Date(result.rows.find((row) => row.id === CARD_1)!.updated_at).toISOString()).toBe(
      "2026-07-14T12:00:00.000Z",
    );
  });
});
