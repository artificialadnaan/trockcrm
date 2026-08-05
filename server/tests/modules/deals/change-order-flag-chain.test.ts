import { describe, expect, it } from "vitest";
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";

/**
 * STRUCTURAL guard against a HALF-WIRED change-order flag.
 *
 * `deals.is_change_order` is the authority for the change-order display relabel, and it reaches the UI
 * through a five-link chain:
 *
 *   SQL projects the column -> mapper copies it onto the response object -> server response type
 *   declares it -> client type declares it -> the consumer passes it to formatDealDisplayName.
 *
 * Break ANY link and the symptom is identical and silent: the field arrives `undefined`, the formatter
 * falls back to parsing the name's shape, no error is thrown and no test fails. Three separate rounds of
 * this work each left a DIFFERENT link broken, which is why this is a check and not a code review note.
 *
 * The two links below are the ones no type system can cover, because rows out of `tenantDb.execute(sql`
 * ...`)` are `any`:
 *
 *   READ_WITHOUT_PROJECTION   a mapper reads `row.<key>` that the query never produced. ALWAYS a bug:
 *                             the value is unconditionally `undefined`. (Shipped in
 *                             getDashboardAtRiskRows: the mapper read `deal_is_change_order` while the
 *                             SELECT never listed it, so every at-risk row guessed from the name.)
 *
 *   PROJECTION_DROPPED_BY_INLINE_MAP
 *                             a query projects the flag and the SAME function maps its rows inline into
 *                             an object literal that omits it. The raw row never escapes, so the column
 *                             is fetched and then thrown away. (Shipped in getCommissionDealRollups.)
 *
 *   REMAP_DROPS_FLAG          a later hand-off copies `dealName` off a source object whose TYPE carries
 *                             the flag, into a new literal that omits it. Neither end is a query, so the
 *                             two checks above are blind to it, and the field is optional so `tsc` says
 *                             nothing. (Shipped in getDirectorDashboard: the at-risk query projected the
 *                             column and buildDashboardAtRiskStaleDeals carried it, then the director
 *                             payload re-mapped the rows and dropped it one line before the client read
 *                             it — so the At Risk list on the director dashboard still guessed from the
 *                             name.) This one needs the TYPE CHECKER, not text matching.
 *
 * The invariant both rest on: FOR A RAW-SQL QUERY, THE ROW KEY IS THE SQL OUTPUT COLUMN NAME. So
 * `d.is_change_order AS deal_is_change_order` is readable as `row.deal_is_change_order` and nothing
 * else. Drizzle's typed `.select({ key: deals.isChangeOrder })` is counted as a projection too — it is
 * type-checked, but it is still how the column gets into the row.
 *
 * Deliberately NOT checked here: the client-side links. Those are ordinary typed property accesses that
 * `tsc` already covers once the field exists on the interface.
 */

const SERVER_SRC = path.resolve(__dirname, "../../../src");

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(p));
    else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) out.push(p);
  }
  return out;
}

/** SQL output column names for the flag that this query produces. */
function projectedKeys(sqlText: string, bodyText: string): Set<string> {
  const out = new Set<string>();
  //  d.is_change_order AS deal_is_change_order   /   AS "dealIsChangeOrder"
  for (const m of sqlText.matchAll(/\bis_change_order\s+AS\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/gi)) out.add(m[1]!);
  //  (array_agg(is_change_order) FILTER (...))[1] AS "oldestDealIsChangeOrder"
  for (const m of sqlText.matchAll(/\)\s*\[1\]\s*AS\s+"?([A-Za-z_][A-Za-z0-9_]*IsChangeOrder)"?/gi)) out.add(m[1]!);
  //  a bare projection line: `d.is_change_order,` or a CTE re-projection `deal_is_change_order,`
  for (const line of sqlText.split("\n")) {
    const m = line.trim().match(/^(?:[A-Za-z_][A-Za-z0-9_]*\.)?(deal_is_change_order|is_change_order)\s*,?$/);
    if (m) out.add(m[1]!);
  }
  //  drizzle typed select: `key: deals.isChangeOrder` puts the column on the row under `key`
  for (const m of bodyText.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*deals\.isChangeOrder\b/g)) out.add(m[1]!);
  return out;
}

/**
 * Row keys read off a RAW row — one whose static type is `any`, i.e. straight out of
 * `tenantDb.execute()`. Deliberately type-aware rather than a text match: a read off a *typed* object
 * (`row: StaleDealRow`) is already guaranteed by `tsc` and is not this rule's business, and counting
 * those produced a false positive the moment a typed remap lived inside a function that also ran SQL.
 */
function rawRowReadKeys(fn: ts.FunctionLikeDeclaration, sf: ts.SourceFile, checker: ts.TypeChecker): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAccessExpression(n) && FLAG_KEYS.test(n.name.getText(sf))) {
      const objectType = checker.getTypeAtLocation(n.expression);
      // `any` means nothing checked this access — the hallmark of a raw execute() row.
      if (objectType.flags & ts.TypeFlags.Any) out.add(n.name.getText(sf));
    }
    ts.forEachChild(n, visit);
  };
  visit(fn.body!);
  return out;
}

/**
 * EVERY read of a flag key in this function, typed or not. The "projected but dropped" direction needs
 * this wider set: a query can legitimately hand its rows to a TYPED mapper, and only the narrower
 * raw-row set belongs to the "read a column that does not exist" rule.
 */
function anyReadKeys(fn: ts.FunctionLikeDeclaration, sf: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAccessExpression(n) && FLAG_KEYS.test(n.name.getText(sf))) out.add(n.name.getText(sf));
    if (ts.isShorthandPropertyAssignment(n) && FLAG_KEYS.test(n.name.getText(sf))) out.add(n.name.getText(sf));
    ts.forEachChild(n, visit);
  };
  visit(fn.body!);
  return out;
}

const FLAG_KEYS = /^(deal_is_change_order|is_change_order|isChangeOrder|dealIsChangeOrder)$/;

/**
 * Local variables that hold RAW ROWS of a query, with the flag keys that query projects.
 *
 * Follows one hop of aliasing, because the common shape is two statements:
 *   const result = await tenantDb.execute(sql`... d.is_change_order AS deal_is_change_order ...`);
 *   const rows = (result as any).rows ?? result;
 */
function queryBackedRowVars(
  fn: ts.FunctionLikeDeclaration,
  sf: ts.SourceFile
): Array<{ receiver: string; keys: Set<string> }> {
  const byName = new Map<string, Set<string>>();
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name)) {
      const init = n.initializer.getText(sf);
      let sqlText = "";
      const collect = (x: ts.Node): void => {
        if (ts.isTemplateExpression(x) || ts.isNoSubstitutionTemplateLiteral(x)) sqlText += x.getFullText(sf);
        ts.forEachChild(x, collect);
      };
      collect(n.initializer);
      if (sqlText) {
        const keys = projectedKeys(sqlText, init);
        if (keys.size) byName.set(n.name.getText(sf), keys);
      } else if (!/\.\s*map\s*\(/.test(init)) {
        // `const rows = (result as any).rows ?? result` — a pure ALIAS inherits the query's keys.
        // A `.map(...)` initializer is excluded on purpose: its result holds MAPPED objects, not raw
        // rows, and treating it as another handle on the query made the detector accuse the very
        // mapper that reads the column correctly.
        for (const [known, keys] of [...byName]) {
          if (new RegExp(`\\b${known}\\b`).test(init)) byName.set(n.name.getText(sf), keys);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(fn.body!);
  return [...byName].map(([receiver, keys]) => ({ receiver, keys }));
}

/**
 * The row keys an inline `<receiver>.map(row => ({ ... }))` READS off its callback parameter, or null
 * when `receiver` is not consumed by such a map here (so its rows escape to a consumer elsewhere).
 *
 * Reads, not writes. The output property is frequently renamed — `isChangeOrder: row.is_change_order`
 * — so comparing the projected column against the emitted property name reports a mapper that is
 * plainly correct. The question this rule asks is whether the mapper ever LOOKED at the column.
 */
function inlineMapReadKeys(
  fn: ts.FunctionLikeDeclaration,
  sf: ts.SourceFile,
  receiver: string
): Set<string> | null {
  let read: Set<string> | null = null;
  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.getText(sf) === "map" &&
      n.expression.expression.getText(sf) === receiver &&
      n.arguments.length === 1
    ) {
      const cb = n.arguments[0]!;
      if (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) {
        let buildsObject = false;
        const found = new Set<string>();
        const scan = (x: ts.Node): void => {
          if (ts.isObjectLiteralExpression(x)) buildsObject = true;
          if (ts.isPropertyAccessExpression(x)) found.add(x.name.getText(sf));
          if (ts.isElementAccessExpression(x) && x.argumentExpression && ts.isStringLiteral(x.argumentExpression)) {
            found.add(x.argumentExpression.text);
          }
          ts.forEachChild(x, scan);
        };
        scan(cb.body);
        // No object literal means this is not the response-shaping mapper (a filter/side-effect
        // callback, say), so it says nothing about whether the column survives.
        if (buildsObject) read = found;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(fn.body!);
  return read;
}

type Problem = { kind: string; where: string; key: string; detail: string };

/**
 * One shared Program for both passes. Built lazily and memoised — it costs a few seconds and both
 * checks need a TypeChecker.
 */
let cachedProgram: ts.Program | undefined;
function getProgram(): ts.Program {
  if (cachedProgram) return cachedProgram;
  const configPath = path.resolve(__dirname, "../../../tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
  cachedProgram = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
  return cachedProgram;
}

function scanServerSrc(): Problem[] {
  const problems: Problem[] = [];
  const program = getProgram();
  const checker = program.getTypeChecker();
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const file = sf.fileName;
    if (!file.includes(`${path.sep}src${path.sep}`) || file.includes(".test.")) continue;
    if (!/is_change_order|isChangeOrder/i.test(sf.text)) continue;

    const fns: ts.FunctionLikeDeclaration[] = [];
    const visit = (node: ts.Node): void => {
      if (
        (ts.isFunctionDeclaration(node) ||
          ts.isMethodDeclaration(node) ||
          ts.isArrowFunction(node) ||
          ts.isFunctionExpression(node)) &&
        node.body &&
        ts.isBlock(node.body)
      ) {
        fns.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);

    for (const fn of fns) {
      const body = fn.body!.getFullText(sf);
      // Only functions that RUN raw SQL. A pure SQL-builder (returns a fragment) and its consumer live
      // in different functions by design, and pairing those would be guesswork.
      const runsRawSql =
        /\.\s*execute\s*[(<][\s\S]{0,80}sql`/.test(body) ||
        /\.\s*query\s*[(<][\s\S]{0,200}`\s*SELECT/i.test(body);
      if (!runsRawSql) continue;

      let sqlText = "";
      const collect = (n: ts.Node): void => {
        if (ts.isTemplateExpression(n) || ts.isNoSubstitutionTemplateLiteral(n)) sqlText += n.getFullText(sf);
        ts.forEachChild(n, collect);
      };
      collect(fn.body!);

      const projected = projectedKeys(sqlText, body);
      const read = rawRowReadKeys(fn, sf, checker);
      const readAnyhow = anyReadKeys(fn, sf);
      if (projected.size === 0 && read.size === 0) continue;

      const name =
        (fn.name && fn.name.getText(sf)) ||
        (ts.isVariableDeclaration(fn.parent) ? fn.parent.name.getText(sf) : "") ||
        "<anonymous>";
      const line = sf.getLineAndCharacterOfPosition(fn.getStart(sf)).line + 1;
      const where = `${path.relative(SERVER_SRC, file)}:${line} ${name}()`;

      for (const key of read) {
        if (!projected.has(key)) {
          problems.push({
            kind: "READ_WITHOUT_PROJECTION",
            where,
            key,
            detail: `mapper reads row.${key}, but this query projects [${[...projected].join(", ") || "nothing"}]`,
          });
        }
      }

      // Now the "fetched then thrown away" direction, PER QUERY rather than per function.
      //
      // Associating each `.map()` with the query whose rows it actually consumes is the whole accuracy
      // of this rule. A function-wide comparison reports a false positive the moment one function runs
      // two queries and maps only one of them inline — real shape, hit immediately in
      // getWorkflowBottlenecksReport, where a stage-aggregate `.map()` has nothing to do with the deal
      // rows that carry the flag.
      for (const { receiver, keys } of queryBackedRowVars(fn, sf)) {
        const mapped = inlineMapReadKeys(fn, sf, receiver);
        if (!mapped) continue; // rows escape this function; a typed consumer elsewhere may read them
        for (const key of keys) {
          if (!mapped.has(key)) {
            problems.push({
              kind: "PROJECTION_DROPPED_BY_INLINE_MAP",
              where,
              key,
              detail:
                `\`${receiver}\` comes from a query projecting '${key}', and the inline mapper over ` +
                `it never reads it (reads [${[...mapped].join(", ") || "nothing"}])`,
            });
          }
        }
      }
    }
  }
  return problems;
}

/**
 * Type-checked pass: an object literal that copies `dealName` off a source whose type carries the
 * change-order flag, but does not carry the flag itself. Uses a real Program because only the checker
 * can answer "does this source type have the field" — the field is optional, so `tsc` itself is happy
 * either way, and that is precisely why this hand-off broke silently.
 */
function scanRemapDrops(): string[] {
  const program = getProgram();
  const checker = program.getTypeChecker();
  const FLAG = /^(dealIsChangeOrder|isChangeOrder|deal_is_change_order|is_change_order)$/;
  const out: string[] = [];

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const rel = path.relative(path.resolve(__dirname, "../../.."), sf.fileName);
    if (!rel.startsWith(`src${path.sep}`) || rel.includes(".test.")) continue;
    if (!/dealName|deal_name/.test(sf.text)) continue;

    const visit = (n: ts.Node): void => {
      if (ts.isObjectLiteralExpression(n)) {
        const names = n.properties.filter((p) => p.name).map((p) => p.name!.getText(sf));
        // Both spellings: a snake_case re-map (`deal_name: row.deal_name`) is the same hand-off, and
        // the narrowing re-maps inside the report services are written that way.
        const dealNameProp = n.properties.find(
          (p) => p.name && (p.name.getText(sf) === "dealName" || p.name.getText(sf) === "deal_name")
        );
        if (dealNameProp && ts.isPropertyAssignment(dealNameProp) && !names.some((x) => FLAG.test(x))) {
          let source: ts.Expression | null = null;
          const findSource = (x: ts.Node): void => {
            const wanted = dealNameProp.name!.getText(sf);
            if (!source && ts.isPropertyAccessExpression(x) && x.name.getText(sf) === wanted) {
              source = x.expression;
            }
            ts.forEachChild(x, findSource);
          };
          findSource(dealNameProp.initializer);
          if (source) {
            const sourceType = checker.getTypeAtLocation(source);
            const sourceHasFlag = checker.getPropertiesOfType(sourceType).some((p) => FLAG.test(p.getName()));
            if (sourceHasFlag) {
              const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
              out.push(
                `${rel}:${line}  copies dealName from \`${(source as ts.Expression).getText(sf)}\` ` +
                  `(whose type carries the change-order flag) into a literal that drops it`
              );
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

describe("deals.is_change_order survives the query -> mapper hand-off in every raw-SQL reader", () => {
  it("no mapper reads a change-order key its own query never produced", () => {
    const problems = scanServerSrc().filter((p) => p.kind === "READ_WITHOUT_PROJECTION");
    expect(
      problems.map((p) => `${p.where}\n    ${p.detail}`),
      "A raw-SQL row key IS the SQL output column name. Reading one the SELECT never produced yields " +
        "undefined forever, and formatDealDisplayName then silently guesses from the deal's name."
    ).toEqual([]);
  });

  it("no query fetches the change-order flag and then drops it in its own inline mapper", () => {
    const problems = scanServerSrc().filter((p) => p.kind === "PROJECTION_DROPPED_BY_INLINE_MAP");
    expect(
      problems.map((p) => `${p.where}\n    ${p.detail}`),
      "The rows never escape this function, so a projected-but-unmapped column can never reach the UI."
    ).toEqual([]);
  });

  it("no later hand-off re-maps a deal row and drops a flag its source already carried", () => {
    expect(
      scanRemapDrops(),
      "The source object already has the authoritative flag. Dropping it here sends the client " +
        "`undefined`, and formatDealDisplayName then relabels by parsing the name — which is wrong for " +
        "any deal a human happened to name '<Something> — Change Order N'."
    ).toEqual([]);
  }, 60000); // builds a real ts.Program over server/src

  it("the scanner actually inspects the services this rule exists for", () => {
    // Guards the guard: a broken glob / changed layout would make both checks above pass vacuously.
    const files = tsFiles(SERVER_SRC);
    expect(files.length).toBeGreaterThan(200);
    for (const expected of [
      "modules/dashboard/service.ts",
      "modules/ai-copilot/service.ts",
      "modules/commissions/reporting-service.ts",
      "modules/reports/service.ts",
    ]) {
      expect(files.some((f) => f.endsWith(expected)), `scanner must cover ${expected}`).toBe(true);
    }
  });
});
