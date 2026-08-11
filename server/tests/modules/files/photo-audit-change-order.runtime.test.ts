import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { deals, files, photoAuditLog, users } from "@trock-crm/shared/schema";
import { formatDealDisplayName } from "@trock-crm/shared/types";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import { getAdminPhotoAuditEvents } from "../../../src/modules/files/audit-log-service.js";

/**
 * `deals.is_change_order` is the AUTHORITY for the change-order display relabel on the admin Photo Audit
 * page, and it has to survive five links: the SQL projects the column -> normalizePhotoAuditRow copies it
 * onto `event.deal` -> PhotoAuditEventRow declares it -> the page's AdminPhotoAuditEvent declares it ->
 * the row passes it to formatDealDisplayName. Break any one and the field arrives `undefined`, the
 * formatter falls back to parsing the NAME, and a deal a human named "Lobby — Change Order 1" is rendered
 * "Change Order 1 — Lobby".
 *
 * Real SQL (PGlite over the actual Drizzle table defs) rather than a mocked `execute`, because the fix IS
 * a SELECT-list change: a mock would happily return a hand-written row for a projection that does not
 * parse. The tables come from tenantSchemaSql so column types/enums match prod by construction.
 *
 * The is_change_order = FALSE row is the DISCRIMINATING case. With the flag missing entirely the TRUE row
 * still renders correctly by coincidence, so a `true`-only assertion would pass on a broken chain.
 */

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const ACTOR = U("a01");
// A deal a HUMAN named with change-order-shaped text — stored is_change_order = FALSE.
const HUMAN_NAMED_DEAL = U("d01");
// A GENERATED change-order child — same name shape, is_change_order = TRUE.
const GENERATED_CO_DEAL = U("d02");
const HUMAN_NAMED_PHOTO = U("f01");
const GENERATED_CO_PHOTO = U("f02");
// A photo with no deal at all: the LEFT JOIN yields NULLs, so `event.deal` must stay null.
const ORPHAN_PHOTO = U("f03");

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;

async function seedPhoto(id: string, dealId: string | null): Promise<void> {
  await pg.exec(
    `INSERT INTO public.files
       (id, category, display_name, system_filename, original_filename, mime_type,
        file_size_bytes, file_extension, r2_key, r2_bucket, uploaded_by, deal_id)
     VALUES ('${id}', 'photo', 'Roof ${id}', 'sys_${id}', 'orig_${id}.jpg', 'image/jpeg',
        1000, '.jpg', 'office_dallas/${id}', 'bucket', '${ACTOR}', ${dealId ? `'${dealId}'` : "NULL"})`,
  );
  await pg.exec(
    `INSERT INTO public.photo_audit_log (photo_id, event_type, user_id)
     VALUES ('${id}', 'downloaded', '${ACTOR}')`,
  );
}

beforeAll(async () => {
  pg = new PGlite();
  // The admin query joins the audited file to public.users (the actor) and LEFT JOINs deals.
  await pg.exec(tenantSchemaSql("public", [files, deals, users, photoAuditLog]));
  tdb = drizzle(pg);

  await pg.exec(
    `INSERT INTO public.users (id, email, display_name, role, office_id)
     VALUES ('${ACTOR}', 'auditor@example.com', 'Ada Auditor', 'admin', '${U("0f1")}')`,
  );
  await pg.exec(
    `INSERT INTO public.deals (id, deal_number, name, stage_id, is_change_order) VALUES
       ('${HUMAN_NAMED_DEAL}', 'TR-1', 'Lobby — Change Order 1', '${U("50a1")}', false),
       ('${GENERATED_CO_DEAL}', 'TR-2', 'Tides Park Lane — Change Order 1', '${U("50a1")}', true)`,
  );

  await seedPhoto(HUMAN_NAMED_PHOTO, HUMAN_NAMED_DEAL);
  await seedPhoto(GENERATED_CO_PHOTO, GENERATED_CO_DEAL);
  await seedPhoto(ORPHAN_PHOTO, null);
}, 30_000);

afterAll(async () => {
  await pg?.close?.();
});

describe("getAdminPhotoAuditEvents — deals.is_change_order reaches the audit table", () => {
  it("returns the flag with event.deal, so a human-named 'Lobby — Change Order 1' is NOT relabelled", async () => {
    const { events } = await getAdminPhotoAuditEvents(tdb, { page: 1, perPage: 50 });
    const byPhoto = new Map(events.map((e) => [e.photo?.id, e]));

    const humanNamed = byPhoto.get(HUMAN_NAMED_PHOTO)?.deal;
    const generated = byPhoto.get(GENERATED_CO_PHOTO)?.deal;
    expect(humanNamed?.name).toBe("Lobby — Change Order 1");
    expect(generated?.name).toBe("Tides Park Lane — Change Order 1");

    // What the audit table actually renders from each row (photo-audit-page.tsx).
    expect(formatDealDisplayName(humanNamed!.name, humanNamed!.isChangeOrder)).toBe("Lobby — Change Order 1");
    expect(formatDealDisplayName(generated!.name, generated!.isChangeOrder)).toBe(
      "Change Order 1 — Tides Park Lane",
    );

    // And the stored value itself reached the payload — not `undefined`, not coerced to false.
    expect(humanNamed?.isChangeOrder).toBe(false);
    expect(generated?.isChangeOrder).toBe(true);
  });

  it("leaves event.deal null for a photo with no deal (the LEFT JOIN produces no flag to claim)", async () => {
    const { events } = await getAdminPhotoAuditEvents(tdb, { page: 1, perPage: 50 });
    const orphan = events.find((e) => e.photo?.id === ORPHAN_PHOTO);
    expect(orphan).toBeDefined();
    expect(orphan?.deal).toBeNull();
  });
});
