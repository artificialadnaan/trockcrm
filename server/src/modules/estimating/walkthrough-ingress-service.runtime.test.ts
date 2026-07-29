// REAL-SQL (PGlite) proof for the first link of the walkthrough ingress chain: the `files` row that a
// synthesized contact-sheet document hangs off.
//
// Why a runtime test rather than a unit test: `files` has TEN NOT NULL columns (display_name,
// system_filename, original_filename, mime_type, file_size_bytes, file_extension, r2_key, r2_bucket,
// uploaded_by, category — plus tags/version/is_active which carry defaults). Omitting any one is a
// 23502 at INSERT that no amount of type-checking catches, because Drizzle's insert type only knows
// about columns without defaults. The table is built from the REAL Drizzle definition via
// tenantSchemaSql, so the NOT NULLs and the file_category enum here are prod's, by construction.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { files } from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../../tests/helpers/tenant-schema-from-drizzle.js";
import { createWalkthroughContactSheetFile } from "./walkthrough-ingress-service.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const DEAL = U("11111");
const WALKTHROUGH = U("22222");
const USER = U("33333");

let pg: PGlite;
// The service is typed against NodePgDatabase; the PGlite driver is wire-compatible for these queries
// but not structurally identical, which is why the repo's other runtime suites hold it loosely.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tenantDb: any;

beforeAll(async () => {
  pg = new PGlite();
  // "public" (not office_*) so the unqualified Drizzle `files` table resolves on the default search_path.
  await pg.exec(tenantSchemaSql("public", [files]));
  tenantDb = drizzle(pg);
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

describe("createWalkthroughContactSheetFile", () => {
  it("inserts a files row satisfying every NOT NULL column, derived from the walkthrough input", async () => {
    const fileId = await createWalkthroughContactSheetFile({
      tenantDb,
      input: {
        dealId: DEAL,
        walkthroughId: WALKTHROUGH,
        siteLabel: "Unit 12B",
        r2Key: "walkthroughs/22222222/contact-sheet.jpg",
        r2Bucket: "trock-scope",
        bytes: 184320,
        mimeType: "image/jpeg",
        userId: USER,
      },
    });

    expect(fileId).toEqual(expect.any(String));

    const [row] = await tenantDb.select().from(files).where(eq(files.id, fileId));

    expect(row).toBeDefined();
    expect(row.mimeType).toBe("image/jpeg");
    expect(row.fileExtension).toBe("jpg");
    expect(row.fileSizeBytes).toBe(184320);
    expect(row.r2Key).toBe("walkthroughs/22222222/contact-sheet.jpg");
    expect(row.r2Bucket).toBe("trock-scope");
    expect(row.displayName).toContain("Unit 12B");
    expect(row.isActive).toBe(true);
    // `category` is a NOT NULL pgEnum — an unset or off-enum value is a 23502/22P02 at insert, so the
    // only meaningful assertion is that it is populated with a real file_category member.
    expect(row.category).toBeTruthy();
    expect(files.category.enumValues).toContain(row.category);
    // Provenance the rest of the chain (and any human opening the file) needs.
    expect(row.dealId).toBe(DEAL);
    expect(row.uploadedBy).toBe(USER);
  });
});
