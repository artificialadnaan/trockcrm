import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  fetchMissingCloseDateDeals,
  groupDealsByRep,
  runReimport,
  type Queryable,
} from "../../../scripts/lib/close-date-workflow.js";
import { buildRepWorkbook, workbookToBuffer, readWorkbookRows, EXPECTED_CLOSE_DATE_HEADER } from "../../../scripts/lib/close-date-xlsx.js";

/**
 * Full-loop integration over REAL on-disk .xlsx files: export query -> group ->
 * build workbook -> write to a file -> read it back FROM THE PATH -> commit
 * re-import -> verify the DB. Exercises the file-path read branch and the exact
 * data path Adnaan runs.
 */
const TODAY = "2026-06-04";
const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const REP = U("a11ce");
const ST = U("57e57");
const D1 = U("d01"); // empty -> filled (WRITTEN)
const D2 = U("d02"); // empty -> left blank in the sheet
const D3 = U("d03"); // stale past date -> refreshed (REFRESHED)

let pg: PGlite;
let client: Queryable;
let tmpDir: string;
let tmpFile: string;

beforeAll(async () => {
  pg = new PGlite();
  client = { query: (text: string, params?: unknown[]) => pg.query(text, params) };
  await pg.exec(`
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text NOT NULL, is_active boolean NOT NULL DEFAULT true);
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL, name text NOT NULL, is_terminal boolean NOT NULL DEFAULT false);
    CREATE SCHEMA office_dallas;
    CREATE TABLE office_dallas.companies (id uuid PRIMARY KEY, name varchar(500) NOT NULL);
    CREATE TABLE office_dallas.deals (
      id uuid PRIMARY KEY, sales_source_user_id uuid, deal_number varchar(50) NOT NULL, name varchar(500) NOT NULL, stage_id uuid NOT NULL,
      assigned_rep_id uuid, company_id uuid, expected_close_date date,
      awarded_amount numeric, bid_estimate numeric, dd_estimate numeric, forecast_revenue numeric,
      is_active boolean NOT NULL DEFAULT true, is_test_data boolean NOT NULL DEFAULT false, is_read_only_mirror boolean NOT NULL DEFAULT false,
      is_bid_board_owned boolean NOT NULL DEFAULT false, on_hold boolean NOT NULL DEFAULT false,
      updated_at timestamptz DEFAULT now()
    );
    INSERT INTO users (id, display_name) VALUES ('${REP}','Alice Rep');
    INSERT INTO pipeline_stage_config (id, slug, name) VALUES ('${ST}','estimating','Estimating');
    INSERT INTO office_dallas.deals (id, deal_number, name, stage_id, assigned_rep_id, expected_close_date) VALUES
      ('${D1}','DFW-1-00001-aa','Roof One','${ST}','${REP}', NULL),
      ('${D2}','DFW-1-00002-aa','Roof Two','${ST}','${REP}', NULL),
      ('${D3}','DFW-1-00003-aa','Roof Three','${ST}','${REP}', '2026-01-01');
  `);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trockcrm-cd-int-"));
  tmpFile = path.join(tmpDir, "close-dates.xlsx");
});

afterAll(async () => {
  await pg?.close?.();
  if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("export -> fill file -> re-import (real files, PGlite)", () => {
  it("round-trips a filled workbook on disk and commits the date to the right deal", async () => {
    // EXPORT
    const groups = groupDealsByRep(await fetchMissingCloseDateDeals(client, ["office_dallas"], TODAY));
    expect(groups).toHaveLength(1);
    const wb = await buildRepWorkbook(groups[0]);

    // REP FILLS the first deal's date, then the file is saved to disk.
    const ws = wb.worksheets[0];
    let headerRow = -1;
    let dateCol = -1;
    let idCol = -1;
    ws.eachRow((row, rn) => {
      row.eachCell((cell, cn) => {
        if (cell.value === EXPECTED_CLOSE_DATE_HEADER) { headerRow = rn; dateCol = cn; }
        if (cell.value === "Deal ID") idCol = cn;
      });
    });
    // REP fills D1 (was empty) and D3 (was stale) with a future date; leaves D2 blank.
    for (let r = headerRow + 1; r <= ws.rowCount; r++) {
      const id = ws.getCell(r, idCol).value;
      if (id === D1 || id === D3) ws.getCell(r, dateCol).value = new Date(Date.UTC(2026, 10, 30));
    }
    fs.writeFileSync(tmpFile, await workbookToBuffer(wb));

    // RE-IMPORT from the path (dry-run first: nothing written)
    const rowsFromFile = await readWorkbookRows(tmpFile);
    const dry = await runReimport({ client, rows: rowsFromFile, validSchemas: new Set(["office_dallas"]), mode: "dry-run", overwriteExisting: false, today: TODAY });
    expect(dry.counts.WRITTEN).toBe(1); // D1
    expect(dry.counts.REFRESHED).toBe(1); // D3 (stale)
    expect(dry.counts.SKIPPED_BLANK).toBe(1); // D2
    const stillStale = await pg.query<{ d: string | null }>(`SELECT to_char(expected_close_date,'YYYY-MM-DD') AS d FROM office_dallas.deals WHERE id = $1`, [D3]);
    expect(stillStale.rows[0].d).toBe("2026-01-01"); // dry-run wrote nothing

    // COMMIT
    const committed = await runReimport({ client, rows: rowsFromFile, validSchemas: new Set(["office_dallas"]), mode: "commit", overwriteExisting: false, today: TODAY });
    expect(committed.counts.WRITTEN).toBe(1);
    expect(committed.counts.REFRESHED).toBe(1);

    const d1 = await pg.query<{ d: string | null }>(`SELECT to_char(expected_close_date,'YYYY-MM-DD') AS d FROM office_dallas.deals WHERE id = $1`, [D1]);
    const d2 = await pg.query<{ d: string | null }>(`SELECT to_char(expected_close_date,'YYYY-MM-DD') AS d FROM office_dallas.deals WHERE id = $1`, [D2]);
    const d3 = await pg.query<{ d: string | null }>(`SELECT to_char(expected_close_date,'YYYY-MM-DD') AS d FROM office_dallas.deals WHERE id = $1`, [D3]);
    expect(d1.rows[0].d).toBe("2026-11-30"); // empty -> filled
    expect(d2.rows[0].d).toBeNull(); // blank row left untouched
    expect(d3.rows[0].d).toBe("2026-11-30"); // stale -> refreshed
  });
});
