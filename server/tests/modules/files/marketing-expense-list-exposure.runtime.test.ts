// An expense-request attachment must be reachable ONLY through a path that authorized the parent request.
//
// Fixing the per-ID handlers was necessary and not sufficient. `GET /api/files` never knew about the new
// association, so every quote, proposal and price list in the office was listed to anyone who could browse
// the Files page — and `getFiles` resolves a signed THUMBNAIL url for images and rasterized PDFs, so the
// contents leaked too, without ever passing the read guard. A `construction` user is not even subject to
// the route's rep-only filter requirement, so they could ask for the unfiltered library.
//
// Authorizing the front door and leaving the window open is worse than doing neither, because the first fix
// creates a reasonable belief that the surface is covered. These cases pin the whole surface, not the door.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { files } from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import { getFiles, getFileStats, getTagSuggestions } from "../../../src/modules/files/service.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const DEAL = U("d1");
const REQUEST = U("e1");
const UPLOADER = U("a1");

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tenantDb: any;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE public.users (id uuid PRIMARY KEY, display_name text, avatar_url text);
    -- buildDealFileScopeCondition reads deals.source_lead_id to follow lead->deal lineage.
    CREATE TABLE public.deals (id uuid PRIMARY KEY, source_lead_id uuid);
    INSERT INTO public.deals (id) VALUES ('00000000-0000-4000-8000-0000000000d1');
  `);
  await pg.exec(tenantSchemaSql("public", [files]));
  await pg.exec(`INSERT INTO public.users (id, display_name) VALUES ('${UPLOADER}', 'Reggie Rep');`);

  const base = `category, display_name, system_filename, original_filename, mime_type,
                file_size_bytes, file_extension, r2_key, r2_bucket, uploaded_by`;
  await pg.exec(`
    INSERT INTO public.files (${base}, deal_id)
    VALUES ('contract', 'deal-contract.pdf', 's1', 'o1', 'application/pdf', 10, '.pdf', 'k1', 'b', '${UPLOADER}', '${DEAL}');
    INSERT INTO public.files (${base}, marketing_expense_request_id, tags)
    VALUES ('proposal', 'expo-quote.pdf', 's2', 'o2', 'application/pdf', 20, '.pdf', 'k2', 'b', '${UPLOADER}', '${REQUEST}', ARRAY['secret-vendor-tag']);
    INSERT INTO public.files (${base}, marketing_expense_request_id)
    VALUES ('photo', 'booth-render.jpg', 's3', 'o3', 'image/jpeg', 30, '.jpg', 'k3', 'b', '${UPLOADER}', '${REQUEST}');
  `);
  tenantDb = drizzle(pg);
}, 30_000);

afterAll(async () => {
  await pg?.close?.();
});

describe("GET /api/files (getFiles)", () => {
  it("does NOT list expense-request attachments in the general library", async () => {
    const result = await getFiles(tenantDb, {});
    const names = result.files.map((file) => file.displayName);
    expect(names).toContain("deal-contract.pdf");
    expect(names).not.toContain("expo-quote.pdf");
    expect(names).not.toContain("booth-render.jpg");
  });

  it("excludes them from the total, not just from the page", async () => {
    const result = await getFiles(tenantDb, {});
    expect(result.pagination.total).toBe(1);
  });

  it("keeps excluding them when the caller asks for photos, where an image attachment would surface", async () => {
    const result = await getFiles(tenantDb, { fileKind: "photos" });
    expect(result.files.map((file) => file.displayName)).not.toContain("booth-render.jpg");
  });

  it("keeps excluding them from the 'unassigned' bucket, which is where a null deal_id would land them", async () => {
    const result = await getFiles(tenantDb, { linkedType: "unassigned" });
    expect(result.files.map((file) => file.displayName)).not.toContain("expo-quote.pdf");
  });

  it("DOES return them when the caller explicitly scopes to the request", async () => {
    // The route that passes this filter has already run assertMarketingExpenseRequestReadAccess. Without
    // this branch the request's own detail page could not show its attachments.
    const result = await getFiles(tenantDb, { marketingExpenseRequestId: REQUEST });
    expect(result.files.map((file) => file.displayName).sort()).toEqual([
      "booth-render.jpg",
      "expo-quote.pdf",
    ]);
  });

  it("still returns ordinary deal files when scoped to a deal", async () => {
    const result = await getFiles(tenantDb, { dealId: DEAL });
    expect(result.files.map((file) => file.displayName)).toEqual(["deal-contract.pdf"]);
  });
});

describe("the other unscoped reads over files", () => {
  it("leaves expense attachments out of the office file stats", async () => {
    const stats = await getFileStats(tenantDb);
    expect(stats.totalFiles).toBe(1);
    expect(stats.totalBytes).toBe(10);
  });

  it("leaves their tags out of the tag autocomplete", async () => {
    const tags = await getTagSuggestions(tenantDb);
    expect(tags).not.toContain("secret-vendor-tag");
  });
});
