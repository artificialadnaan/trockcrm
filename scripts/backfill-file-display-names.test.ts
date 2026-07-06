import { describe, expect, it } from "vitest";
import {
  buildRenamePlan,
  deriveHistoricalDisplayName,
  isSyntheticPhotoRow,
  parseArgs,
  type FileRow,
} from "./backfill-file-display-names.js";

// Pure planner/guard coverage for the display-name backfill. The rename is eligible only for AUTO-NAMED,
// NON-synthetic rows with a real original_filename — which INCLUDES genuine web/desktop photos (renamed to
// their real name, matching the new seed + spec §5.1) and EXCLUDES field/CompanyCam captures. The
// historical-name derivation is version-agnostic (reproduced from the stored system_filename, so it also
// matches the oldest pre-shortId rows the current generator would skip).

const rows: FileRow[] = [
  // 1. pre-Fix-3 doc (system_filename WITHOUT the 8-char shortId) — still auto-named.
  {
    id: "doc-old",
    displayName: "TR-2026-0001 Contract 2026-01-01 001",
    systemFilename: "TR-2026-0001_Contract_2026-01-01_001.pdf",
    originalFilename: "Signed Contract.pdf",
    category: "contract",
  },
  // 2. post-Fix-3 doc (WITH shortId) — still auto-named.
  {
    id: "doc-new",
    displayName: "TR-2026-0002 Estimate 2026-02-01 001 ab12cd34",
    systemFilename: "TR-2026-0002_Estimate_2026-02-01_001_ab12cd34.pdf",
    originalFilename: "Bid Estimate v2.pdf",
    category: "estimate",
  },
  // 3. edited row (display_name diverged from the derived system name) — skip the rename.
  {
    id: "edited",
    displayName: "My Custom Name",
    systemFilename: "TR-2026-0003_Other_2026-03-01_001_cc33dd44.pdf",
    originalFilename: "whatever.pdf",
    category: "other",
  },
  // 4. CompanyCam capture — SYNTHETIC, protected.
  {
    id: "companycam",
    displayName: "TR-2026-0004 CompanyCam 2026-04-01",
    systemFilename: "TR-2026-0004_Photo_2026-04-01_001_ee55ff66.jpg",
    originalFilename: "companycam_abc123.jpg",
    category: "photo",
  },
  // 5. field/TRCAM capture — SYNTHETIC, protected.
  {
    id: "field",
    displayName: "TR-2026-0005 Photo 2026-05-01 001 gg77hh88",
    systemFilename: "TR-2026-0005_Photo_2026-05-01_001_gg77hh88.jpg",
    originalFilename: "field-photo-1699999999.jpg",
    category: "photo",
  },
  // 6. web/desktop photo — auto-named but a REAL original_filename → renamed like a document.
  {
    id: "web-photo",
    displayName: "TR-2026-0006 Photo 2026-06-01 001 zz99yy88",
    systemFilename: "TR-2026-0006_Photo_2026-06-01_001_zz99yy88.jpg",
    originalFilename: "Kitchen Damage.jpg",
    category: "photo",
  },
  // 7. empty original_filename — nothing to rename to.
  {
    id: "empty",
    displayName: "TR-2026-0007 Other 2026-07-01 001 aa00bb11",
    systemFilename: "TR-2026-0007_Other_2026-07-01_001_aa00bb11.pdf",
    originalFilename: "",
    category: "other",
  },
];

describe("backfill display-name planner", () => {
  it("renames the two auto-named docs AND the web-photo; protects synthetic + empty; skips edited", () => {
    const plan = buildRenamePlan(rows);
    expect(plan.rename.map((r) => r.id).sort()).toEqual(["doc-new", "doc-old", "web-photo"]);
    expect(plan.renameDocs).toBe(2);
    expect(plan.renameWebPhotos).toBe(1);
    expect(plan.alreadyEdited).toBe(1);
    expect(plan.synthetic).toBe(2);
    expect(plan.emptyOriginal).toBe(1);
  });

  it("sets each planned new name to the ext-stripped original_filename", () => {
    const byId = Object.fromEntries(buildRenamePlan(rows).rename.map((r) => [r.id, r.to]));
    expect(byId["doc-old"]).toBe("Signed Contract");
    expect(byId["doc-new"]).toBe("Bid Estimate v2");
    expect(byId["web-photo"]).toBe("Kitchen Damage");
  });

  it("deriveHistoricalDisplayName reproduces the stored auto-name (version-agnostic)", () => {
    expect(deriveHistoricalDisplayName("TR-2026-0001_Contract_2026-01-01_001.pdf")).toBe("TR-2026-0001 Contract 2026-01-01 001");
    expect(deriveHistoricalDisplayName("TR-2026-0002_Estimate_2026-02-01_001_ab12cd34.pdf")).toBe("TR-2026-0002 Estimate 2026-02-01 001 ab12cd34");
  });

  it("isSyntheticPhotoRow is true ONLY for the CompanyCam + field-photo fixtures", () => {
    const synthetic = rows.filter(isSyntheticPhotoRow).map((r) => r.id).sort();
    expect(synthetic).toEqual(["companycam", "field"]);
  });
});

describe("backfill CLI args", () => {
  it("defaults to dry-run and accepts --commit", () => {
    expect(parseArgs(["node", "script"]).mode).toBe("dry-run");
    expect(parseArgs(["node", "script", "--commit"]).mode).toBe("commit");
  });

  it("rejects passing both --dry-run and --commit", () => {
    expect(() => parseArgs(["node", "script", "--dry-run", "--commit"])).toThrow(/exactly one/i);
  });
});
