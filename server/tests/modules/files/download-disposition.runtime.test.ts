import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { files } from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import { resolveInlineDisposition, getFileDownloadUrl } from "../../../src/modules/files/service.js";

/**
 * Security-critical: inline Content-Disposition is a stored-XSS surface, so it is allowlisted to
 * image/* (NOT image/svg+xml), application/pdf, and text/plain — everything else is forced to attachment,
 * and any request that did not explicitly ask for inline is attachment.
 *
 * The pure resolver is asserted directly. The end-to-end wiring is proven through getFileDownloadUrl:
 * with no R2 env, buildFileDownloadUrlFromRecord falls back to generateMockDownloadUrl, which now encodes
 * the resolved disposition in the URL (`&disposition=`), so we can assert what the presign WOULD carry.
 * (The REAL signed ResponseContentDisposition header is separately proven in server/src/lib/r2-client.test.ts.)
 */

const USER = "00000000-0000-4000-8000-000000000001";
let tdb: ReturnType<typeof drizzle>;
let pg: PGlite;

function dispositionOf(url: string): string | null {
  const m = url.match(/[?&]disposition=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

const base = {
  folder_path: "Contracts",
  system_filename: "sys.bin",
  original_filename: "orig.bin",
  file_size_bytes: "10",
  r2_bucket: "trockcrm",
  r2_key: "office_x/deals/D-1/docs/",
  display_name: "doc",
  uploaded_by: USER,
  is_active: "true",
};

async function insert(id: string, mime: string, ext: string) {
  await pg.exec(
    `INSERT INTO files (id, category, mime_type, file_extension, ${Object.keys(base).join(",")})
     VALUES ('${id}', 'contract', '${mime}', '${ext}',
     ${Object.values({ ...base, r2_key: base.r2_key + id })
       .map((v) => `'${String(v).replace(/'/g, "''")}'`)
       .join(",")});`,
  );
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`SET TimeZone='UTC';`);
  await pg.exec(tenantSchemaSql("public", [files]));
  tdb = drizzle(pg, { schema: { files } });
  await insert("00000000-0000-4000-8000-0000000000a1", "application/pdf", ".pdf");
  await insert("00000000-0000-4000-8000-0000000000a2", "image/svg+xml", ".svg");
  await insert("00000000-0000-4000-8000-0000000000a3", "image/png", ".png");
  await insert("00000000-0000-4000-8000-0000000000a4", "text/html", ".html");
});

afterAll(async () => {
  await pg.close();
});

describe("resolveInlineDisposition", () => {
  it("returns inline for the allowlist ONLY when inline was requested", () => {
    expect(resolveInlineDisposition("application/pdf", "inline")).toBe("inline");
    expect(resolveInlineDisposition("image/png", "inline")).toBe("inline");
    expect(resolveInlineDisposition("image/jpeg; charset=binary", "inline")).toBe("inline");
    expect(resolveInlineDisposition("text/plain", "inline")).toBe("inline");
  });

  it("forces attachment for SVG, HTML, Office, and unknown even when inline is requested", () => {
    expect(resolveInlineDisposition("image/svg+xml", "inline")).toBe("attachment");
    expect(resolveInlineDisposition("text/html", "inline")).toBe("attachment");
    expect(resolveInlineDisposition("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "inline")).toBe("attachment");
    expect(resolveInlineDisposition("application/octet-stream", "inline")).toBe("attachment");
    expect(resolveInlineDisposition(null, "inline")).toBe("attachment");
  });

  it("defaults to attachment when inline was not requested", () => {
    expect(resolveInlineDisposition("application/pdf", undefined)).toBe("attachment");
    expect(resolveInlineDisposition("image/png", "attachment")).toBe("attachment");
    expect(resolveInlineDisposition("text/plain", "download")).toBe("attachment");
  });
});

describe("getFileDownloadUrl end-to-end disposition", () => {
  it("serves inline for a PDF when requested", async () => {
    const { url } = await getFileDownloadUrl(tdb as never, "00000000-0000-4000-8000-0000000000a1", "inline");
    expect(dispositionOf(url)).toBe("inline");
  });

  it("forces attachment for an SVG even when inline is requested (stored-XSS guard)", async () => {
    const { url } = await getFileDownloadUrl(tdb as never, "00000000-0000-4000-8000-0000000000a2", "inline");
    expect(dispositionOf(url)).toBe("attachment");
  });

  it("forces attachment for text/html even when inline is requested", async () => {
    const { url } = await getFileDownloadUrl(tdb as never, "00000000-0000-4000-8000-0000000000a4", "inline");
    expect(dispositionOf(url)).toBe("attachment");
  });

  it("serves attachment for a PNG when inline is NOT requested (default download)", async () => {
    const { url } = await getFileDownloadUrl(tdb as never, "00000000-0000-4000-8000-0000000000a3", undefined);
    expect(dispositionOf(url)).toBe("attachment");
  });
});
