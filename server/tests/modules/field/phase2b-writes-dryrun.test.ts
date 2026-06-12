// ─── Phase 2b CHECKPOINT 1 — DRY-RUN (writes NOTHING) ────────────────────────────────────────────
//
// For a set of cross-office cases, this resolves where each field write WOULD land and derives the three
// office-bound hazards — (a) the schema/search_path the INSERT/UPDATE runs in, (b) the R2 key prefix, and
// (c) the job_queue.office_id — using the SAME pure decision function (pickWriteOfficeSource) the routes
// use, plus a fixed office-ownership fixture (no DB, no R2, no job enqueue). It asserts each case binds to
// the DEAL's office (flag on) / the uploader's office (flag off), prints the table, and writes nothing.
//
// Run: npx vitest run tests/modules/field/phase2b-writes-dryrun.test.ts
import { describe, expect, it } from "vitest";
import { pickWriteOfficeSource } from "../../../src/modules/field/cross-office.js";

type Office = { id: string; slug: string };
const DALLAS: Office = { id: "id-dallas", slug: "dallas" };
const ATLANTA: Office = { id: "id-atlanta", slug: "atlanta" };

// Fixed ownership fixture (stands in for the DB resolver): which office owns each id.
const OWNER: Record<string, Office> = {
  "deal-atl-100": ATLANTA, // a cross-office deal (dealNumber ATL-100), uploader is in Dallas
  "deal-dal-200": DALLAS, // a same-office deal (dealNumber DAL-200)
  "lead-atl-300": ATLANTA, // a cross-office lead
  "photo-dal-900": DALLAS, // a pending photo parked in Dallas (the uploader's office)
};
const DEAL_NUMBER: Record<string, string> = { "deal-atl-100": "ATL-100", "deal-dal-200": "DAL-200" };

type Case = {
  name: string;
  flag: boolean;
  endpoint: "upload-url" | "confirm-upload" | "assign-target";
  uploaderOffice: Office; // the user's active office
  target: { dealId?: string; leadId?: string; opportunityId?: string };
  photoId?: string; // assign-target only
  expect: { rejected?: boolean; schema?: string; r2Prefix?: string; jobOfficeId?: string };
};

const CASES: Case[] = [
  {
    name: "direct capture · cross-office deal (Dallas user → Atlanta deal)",
    flag: true,
    endpoint: "upload-url",
    uploaderOffice: DALLAS,
    target: { dealId: "deal-atl-100" },
    expect: { schema: "office_atlanta", r2Prefix: "office_atlanta/deals/ATL-100/photo/", jobOfficeId: "id-atlanta" },
  },
  {
    name: "direct capture · same-office deal (Dallas user → Dallas deal)",
    flag: true,
    endpoint: "upload-url",
    uploaderOffice: DALLAS,
    target: { dealId: "deal-dal-200" },
    expect: { schema: "office_dallas", r2Prefix: "office_dallas/deals/DAL-200/photo/", jobOfficeId: "id-dallas" },
  },
  {
    name: "unassigned upload · no target (parks in the uploader's office)",
    flag: true,
    endpoint: "upload-url",
    uploaderOffice: DALLAS,
    target: {},
    expect: { schema: "office_dallas", r2Prefix: "office_dallas/unassociated/photo/", jobOfficeId: "id-dallas" },
  },
  {
    name: "confirm-upload · cross-office deal (job office follows the deal)",
    flag: true,
    endpoint: "confirm-upload",
    uploaderOffice: DALLAS,
    target: { dealId: "deal-atl-100" },
    expect: { schema: "office_atlanta", jobOfficeId: "id-atlanta" },
  },
  {
    name: "cross-office LEAD target (Dallas user → Atlanta lead)",
    flag: true,
    endpoint: "upload-url",
    uploaderOffice: DALLAS,
    target: { leadId: "lead-atl-300" },
    expect: { schema: "office_atlanta", r2Prefix: "office_atlanta/leads/lead-atl-300/photo/", jobOfficeId: "id-atlanta" },
  },
  {
    name: "assign-target · pending Dallas photo → Atlanta deal (CROSS-SCHEMA → REJECT)",
    flag: true,
    endpoint: "assign-target",
    uploaderOffice: DALLAS,
    photoId: "photo-dal-900",
    target: { dealId: "deal-atl-100" },
    expect: { rejected: true },
  },
  {
    name: "FLAG OFF · cross-office deal stays single-office (today's behavior, uploader's office)",
    flag: false,
    endpoint: "upload-url",
    uploaderOffice: DALLAS,
    target: { dealId: "deal-atl-100" },
    expect: { schema: "office_dallas", r2Prefix: "office_dallas/deals/unknown/photo/", jobOfficeId: "id-dallas" },
  },
];

/** Re-implements the route's office decision against the fixture (no DB) — mirrors resolveFieldWriteOffice. */
function resolveOffice(c: Case): Office {
  const source = pickWriteOfficeSource(c.flag, c.target);
  if (source === "uploader") return c.uploaderOffice;
  return OWNER[source.id]!;
}

function r2Prefix(office: Office, c: Case): string {
  const dealLike = c.target.dealId ?? c.target.opportunityId;
  if (dealLike) {
    // The deal-number lookup runs in the RESOLVED schema. Flag-off resolves to the uploader's office,
    // where a cross-office deal isn't present → the number lookup misses → "unassociated"/"unknown".
    const sameOffice = OWNER[dealLike]?.id === office.id;
    const dealNumber = sameOffice ? DEAL_NUMBER[dealLike] : undefined;
    return dealNumber ? `office_${office.slug}/deals/${dealNumber}/photo/` : `office_${office.slug}/deals/unknown/photo/`;
  }
  if (c.target.leadId) return `office_${office.slug}/leads/${c.target.leadId}/photo/`;
  return `office_${office.slug}/unassociated/photo/`;
}

describe("Phase 2b dry-run — resolve + derive the 3 hazards, write nothing", () => {
  const report: Array<Record<string, string>> = [];

  for (const c of CASES) {
    it(c.name, () => {
      if (c.endpoint === "assign-target") {
        // The photo lives in its parked office; the target deal in another → cross-schema move → reject.
        const photoOffice = OWNER[c.photoId!]!;
        const targetOffice = resolveOffice(c);
        const rejected = c.flag && photoOffice.id !== targetOffice.id;
        report.push({
          case: c.name,
          flag: String(c.flag),
          decision: rejected ? "REJECT 409 (no write)" : `assign in office_${photoOffice.slug}`,
        });
        expect(rejected).toBe(Boolean(c.expect.rejected));
        return;
      }

      const office = resolveOffice(c);
      const schema = `office_${office.slug}`;
      const prefix = r2Prefix(office, c);
      report.push({
        case: c.name,
        flag: String(c.flag),
        "(a) schema": schema,
        "(b) r2 prefix": prefix,
        "(c) job office": office.id,
      });

      if (c.expect.schema) expect(schema).toBe(c.expect.schema);
      if (c.expect.r2Prefix) expect(prefix).toBe(c.expect.r2Prefix);
      if (c.expect.jobOfficeId) expect(office.id).toBe(c.expect.jobOfficeId);
    });
  }

  it("prints the dry-run report (writes nothing)", () => {
    // eslint-disable-next-line no-console
    console.log("\n=== Phase 2b cross-office WRITE dry-run (no DB / no R2 / no job written) ===");
    for (const row of report) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(row));
    }
    expect(report.length).toBeGreaterThan(0);
  });
});
