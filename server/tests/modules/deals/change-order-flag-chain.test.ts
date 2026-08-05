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
 * SCOPE of READ_WITHOUT_PROJECTION, since this is the part that reads as over-broad and is not: it
 * inspects reads rooted at a RAW RESULT ROW ONLY — a variable assigned from `execute(sql`...`)`, an
 * alias/unwrap/index of one, or a callback parameter of an iteration over one (see `isRawRowExpr`).
 * An access on a Drizzle SCHEMA OBJECT (`deals.isChangeOrder` inside `.select({...})` or `.groupBy()`)
 * and an access on a typed builder result (`currentDeal[0].isChangeOrder`) are query-builder inputs and
 * typed rows respectively, and are excluded by that scope — not by a type-checker side effect, and not
 * by any downstream heuristic that happens to pair them away.
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

const FLAG_KEYS = /^(deal_is_change_order|is_change_order|isChangeOrder|dealIsChangeOrder)$/;

/** Wrappers that do not change WHAT an expression evaluates to, only how it is typed or awaited. */
function peel(e: ts.Expression): ts.Expression {
  let x = e;
  for (;;) {
    if (
      ts.isParenthesizedExpression(x) ||
      ts.isAwaitExpression(x) ||
      ts.isNonNullExpression(x) ||
      ts.isAsExpression(x) ||
      ts.isTypeAssertionExpression(x) ||
      ts.isSatisfiesExpression(x)
    ) {
      x = x.expression;
      continue;
    }
    return x;
  }
}

/** The call that actually RUNS raw SQL: `tenantDb.execute(sql`...`)` / `client.query(`SELECT ...`)`. */
function isRawSqlCall(e: ts.Expression, sf: ts.SourceFile): boolean {
  if (!ts.isCallExpression(e) || !ts.isPropertyAccessExpression(e.expression)) return false;
  const method = e.expression.name.getText(sf);
  if (method !== "execute" && method !== "query") return false;
  return e.arguments.some((arg) => {
    const a = peel(arg);
    if (ts.isTaggedTemplateExpression(a)) return a.tag.getText(sf) === "sql";
    if (ts.isNoSubstitutionTemplateLiteral(a) || ts.isTemplateExpression(a)) return /\bSELECT\b/i.test(a.getText(sf));
    return false;
  });
}

/** Array methods that hand back the SAME rows (a narrowed or reordered view of them). */
const ROW_PRESERVING_METHODS = /^(slice|filter|concat|reverse|sort|flat|at)$/;
/** Array methods whose first callback parameter IS one row of the receiver. */
const ROW_ITERATING_METHODS = /^(map|forEach|filter|flatMap|find|findLast|findIndex|some|every)$/;
/** The helper every service in this repo uses to unwrap an execute() result into its row array. */
const ROW_UNWRAP_CALLEE = /^rowsFromExecute$/;

/**
 * For `const [a, b] = await runBatch([ <a's source>, <b's source> ])`, the per-position source
 * expressions — unwrapping a `() => ...` thunk to what it returns. `Promise.all`, `runSequential` and
 * friends all have this shape, and it is the only way the tuple names can be told apart: one element is
 * a raw `execute()`, the next is a typed helper, and binding them alike would be a guess in both
 * directions.
 */
function tupleSourceElements(init: ts.Expression, sf: ts.SourceFile): ts.Expression[] | null {
  const call = peel(init);
  if (!ts.isCallExpression(call)) return null;
  const first = call.arguments[0] ? peel(call.arguments[0]!) : undefined;
  if (!first || !ts.isArrayLiteralExpression(first)) return null;
  return first.elements.map((el) => {
    const e = peel(el);
    //  `() => tenantDb.execute(sql`...`)` — the thunk's value is what lands in the tuple slot.
    if ((ts.isArrowFunction(e) || ts.isFunctionExpression(e)) && !ts.isBlock(e.body)) return e.body;
    return e;
  });
}

/**
 * Lexical scopes, innermost last, each mapping a bound name to "does it hold raw rows".
 *
 * A flat name set is NOT enough and the difference is not academic: one service function routinely maps
 * two different arrays and calls the callback parameter `row` in both — a raw one and a TYPED one —
 * and a flat set lets the raw binding vouch for the typed sibling. That is a false positive on real,
 * correct code (getUnifiedWorkflowOverview and getDirectorCommissionEvidence both have this shape).
 */
class RawScopes {
  private readonly frames: Array<Map<string, boolean>> = [new Map()];
  push(): void {
    this.frames.push(new Map());
  }
  pop(): void {
    this.frames.pop();
  }
  bind(name: string, raw: boolean): void {
    this.frames[this.frames.length - 1]!.set(name, raw);
  }
  lookup(name: string): boolean {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const hit = this.frames[i]!.get(name);
      if (hit !== undefined) return hit;
    }
    return false;
  }
}

/**
 * Does this expression evaluate to the RAW ROWS of a raw-SQL execution in this function?
 *
 * This is the whole scope of the READ_WITHOUT_PROJECTION rule, and it is answered STRUCTURALLY — by
 * walking back to the binding the read is rooted at — never by asking the type checker whether the
 * receiver is `any`. Two consequences, both deliberate:
 *
 *   - `deals.isChangeOrder` inside `.select({ dealIsChangeOrder: deals.isChangeOrder })` is a Drizzle
 *     TABLE OBJECT property, i.e. an input to the query builder. `deals` is an imported schema binding,
 *     never a row of anything, so it is out of scope by construction rather than because the checker
 *     happened to give it a type. Same for `currentDeal[0].isChangeOrder`, where `currentDeal` came
 *     from `tenantDb.select()...` — a typed builder result, not a raw row.
 *   - The rule no longer changes verdict when module types fail to resolve. An `any`-based rule fires on
 *     BOTH of the accesses above the moment `drizzle-orm` or `shared/dist` is missing from the Program,
 *     which is a property of the checkout, not of the code being checked.
 */
function isRawRowExpr(e: ts.Expression, sf: ts.SourceFile, rawVars: RawScopes): boolean {
  const x = peel(e);
  if (ts.isIdentifier(x)) return rawVars.lookup(x.getText(sf));
  //  `result.rows` — the row array hanging off an execute() result
  if (ts.isPropertyAccessExpression(x)) return x.name.getText(sf) === "rows" && isRawRowExpr(x.expression, sf, rawVars);
  //  `rows[0]`
  if (ts.isElementAccessExpression(x)) return isRawRowExpr(x.expression, sf, rawVars);
  //  `(result as any).rows ?? result`
  if (
    ts.isBinaryExpression(x) &&
    (x.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      x.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return isRawRowExpr(x.left, sf, rawVars) || isRawRowExpr(x.right, sf, rawVars);
  }
  //  `truncated ? allRows.slice(0, MAX_ROWS) : allRows`
  if (ts.isConditionalExpression(x)) {
    return isRawRowExpr(x.whenTrue, sf, rawVars) || isRawRowExpr(x.whenFalse, sf, rawVars);
  }
  if (ts.isCallExpression(x)) {
    if (isRawSqlCall(x, sf)) return true;
    const callee = peel(x.expression);
    //  `rowsFromExecute<any>(result)`. ONLY this callee: an arbitrary call that merely takes rows as an
    //  argument returns something else entirely — `staleDealRowsFromEngine(rowsFromExecute(r), now)`
    //  hands back TYPED StaleDealRow objects, and treating those as raw rows is precisely the false
    //  positive that made an earlier round of this rule unusable.
    if (ts.isIdentifier(callee) && ROW_UNWRAP_CALLEE.test(callee.getText(sf))) {
      return x.arguments.some((a) => isRawRowExpr(a, sf, rawVars));
    }
    if (ts.isPropertyAccessExpression(callee) && ROW_PRESERVING_METHODS.test(callee.name.getText(sf))) {
      return isRawRowExpr(callee.expression, sf, rawVars);
    }
  }
  return false;
}

/**
 * Flag keys this function reads off a RAW result row.
 *
 * ONE ordered walk that carries the lexical scope with it: a binding becomes "raw" only where its
 * initializer evaluates to raw rows, and a read counts only where the expression it is rooted at is raw
 * AT THAT POINT IN SCOPE. So a query-builder projection (`deals.isChangeOrder`) and a typed builder row
 * (`currentDeal[0].isChangeOrder`) are out of scope by construction, and a `row` that shadows a raw
 * `row` in a sibling mapper does not inherit its raw-ness.
 */
function rawRowReadKeys(fn: ts.FunctionLikeDeclaration, sf: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  const scopes = new RawScopes();

  const walk = (n: ts.Node): void => {
    //  `row.deal_is_change_order` / `row["deal_is_change_order"]` — the read this rule is about.
    if (ts.isPropertyAccessExpression(n) && FLAG_KEYS.test(n.name.getText(sf)) && isRawRowExpr(n.expression, sf, scopes)) {
      out.add(n.name.getText(sf));
    }
    if (
      ts.isElementAccessExpression(n) &&
      n.argumentExpression &&
      ts.isStringLiteral(n.argumentExpression) &&
      FLAG_KEYS.test(n.argumentExpression.text) &&
      isRawRowExpr(n.expression, sf, scopes)
    ) {
      out.add(n.argumentExpression.text);
    }

    //  `const result = await tenantDb.execute(sql`...`)`, `const rows = (result as any).rows ?? result`
    if (ts.isVariableDeclaration(n)) {
      if (n.initializer) walk(n.initializer); // the initializer is evaluated BEFORE the name is bound
      if (ts.isIdentifier(n.name)) {
        scopes.bind(n.name.getText(sf), n.initializer ? isRawRowExpr(n.initializer, sf, scopes) : false);
      } else if (
        ts.isObjectBindingPattern(n.name) &&
        n.initializer &&
        isRawRowExpr(n.initializer, sf, scopes)
      ) {
        //  `const { rows } = await client.query<...>(`SELECT ...`)`, and equally `const { rows } =
        //  result` one statement later. Asking `isRawRowExpr` rather than "is the initializer ITSELF a
        //  raw-SQL call" is what makes the alias hop count — the direct-call form is already one of the
        //  answers it gives, so this is strictly wider, never narrower.
        for (const el of n.name.elements) {
          if ((el.propertyName ?? el.name).getText(sf) === "rows" && ts.isIdentifier(el.name)) {
            scopes.bind(el.name.getText(sf), true);
          }
        }
      } else if (ts.isArrayBindingPattern(n.name) && n.initializer) {
        //  `const [aResult, bResult] = await runSequential([() => tenantDb.execute(sql`...`), () => helper()])`
        //  — the dashboard's batching shape. Positional, so each name is raw exactly when ITS element is,
        //  which is what keeps the typed helpers in the same batch out of the raw set.
        const batch = tupleSourceElements(n.initializer, sf);
        n.name.elements.forEach((el, i) => {
          const source = batch?.[i];
          if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) {
            scopes.bind(el.name.getText(sf), source ? isRawRowExpr(source, sf, scopes) : false);
          }
        });
      }
      return;
    }

    //  `rows.map((row) => ...)` — the first callback parameter is one row OF THIS RECEIVER, and only
    //  of this receiver. Every other parameter (index, array) is not a row.
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ROW_ITERATING_METHODS.test(n.expression.name.getText(sf))
    ) {
      const rowsAreRaw = isRawRowExpr(n.expression.expression, sf, scopes);
      walk(n.expression.expression);
      n.arguments.forEach((arg, i) => {
        if (i === 0 && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))) {
          scopes.push();
          arg.parameters.forEach((p, pi) => {
            if (ts.isIdentifier(p.name)) scopes.bind(p.name.getText(sf), pi === 0 && rowsAreRaw);
          });
          walk(arg.body);
          scopes.pop();
        } else {
          walk(arg);
        }
      });
      return;
    }

    //  `for (const row of rows)`
    if (ts.isForOfStatement(n)) {
      const rowsAreRaw = isRawRowExpr(n.expression, sf, scopes);
      walk(n.expression);
      scopes.push();
      const decl = n.initializer;
      if (ts.isVariableDeclarationList(decl) && decl.declarations[0] && ts.isIdentifier(decl.declarations[0].name)) {
        scopes.bind(decl.declarations[0].name.getText(sf), rowsAreRaw);
      }
      walk(n.statement);
      scopes.pop();
      return;
    }

    //  Any other function boundary: its parameters come from its CALLER, so none of them is a row of a
    //  query run here. A fresh frame also stops an inner name leaking back out.
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) {
      scopes.push();
      for (const p of n.parameters) if (ts.isIdentifier(p.name)) scopes.bind(p.name.getText(sf), false);
      if (n.body) walk(n.body);
      scopes.pop();
      return;
    }

    if (ts.isBlock(n)) {
      scopes.push();
      ts.forEachChild(n, walk);
      scopes.pop();
      return;
    }

    ts.forEachChild(n, walk);
  };

  ts.forEachChild(fn.body!, walk);
  return out;
}

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
 * One shared Program for both passes. Built lazily and memoised — it costs a few seconds, and while
 * only REMAP_DROPS needs a TypeChecker, both passes need the same parsed source files.
 */
function parsedServerConfig(): ts.ParsedCommandLine {
  const configPath = path.resolve(__dirname, "../../../tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  return ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
}

let cachedProgram: ts.Program | undefined;
function getProgram(): ts.Program {
  if (cachedProgram) return cachedProgram;
  const parsed = parsedServerConfig();
  cachedProgram = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
  return cachedProgram;
}

/**
 * The same sources, in a Program where NOTHING imported resolves — every `drizzle-orm` and
 * `@trock-crm/shared` type comes back `any`. This is not a hypothetical: it is what a checkout without
 * `server/node_modules`, or with `shared/dist` unbuilt, hands the compiler.
 */
let cachedTypelessProgram: ts.Program | undefined;
function getTypelessProgram(): ts.Program {
  if (cachedTypelessProgram) return cachedTypelessProgram;
  const parsed = parsedServerConfig();
  cachedTypelessProgram = ts.createProgram(parsed.fileNames, {
    ...parsed.options,
    noEmit: true,
    //  `noResolve`, not `moduleResolution: Classic`: Classic is REJECTED against this repo's
    //  `module: NodeNext` (TS5109, plus TS5070 for resolveJsonModule), so it configures the Program with
    //  an option combination tsc itself reports as invalid. `noResolve` says the intended thing — follow
    //  no imports — with no diagnostics, and produces the same `any` receivers over the same 47 files.
    noResolve: true,
    baseUrl: undefined,
    paths: undefined,
    types: [],
    typeRoots: [],
  });
  return cachedTypelessProgram;
}

function scanServerSrc(program: ts.Program = getProgram()): Problem[] {
  const problems: Problem[] = [];
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const file = sf.fileName;
    if (!file.includes(`${path.sep}src${path.sep}`) || file.includes(".test.")) continue;
    if (!/is_change_order|isChangeOrder/i.test(sf.text)) continue;

    // The enclosing `const <name> = ...` is carried DOWN the walk rather than read back off
    // `node.parent`: parent pointers are only populated once the checker binds a file, and this pass no
    // longer asks the checker anything, so half the files would arrive unbound.
    const fns: Array<{ fn: ts.FunctionLikeDeclaration; declaredAs: string }> = [];
    const visit = (node: ts.Node, declaredAs: string): void => {
      if (
        (ts.isFunctionDeclaration(node) ||
          ts.isMethodDeclaration(node) ||
          ts.isArrowFunction(node) ||
          ts.isFunctionExpression(node)) &&
        node.body &&
        ts.isBlock(node.body)
      ) {
        fns.push({ fn: node, declaredAs });
      }
      const childName =
        ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) ? node.name.getText(sf) : declaredAs;
      ts.forEachChild(node, (child) => visit(child, childName));
    };
    visit(sf, "");

    for (const { fn, declaredAs } of fns) {
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
      const read = rawRowReadKeys(fn, sf);
      if (projected.size === 0 && read.size === 0) continue;

      const name = (fn.name && fn.name.getText(sf)) || declaredAs || "<anonymous>";
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

/**
 * Flag keys READ_WITHOUT_PROJECTION would count in a snippet.
 *
 * No Program, no checker, no files on disk — which is the point. The rule is pure syntax now, so the
 * shapes it must and must not recognise can be stated directly instead of being inferred from whatever
 * `server/src` happens to contain today. A scan of existing code can only ever confirm the shapes that
 * already exist in it.
 */
function readKeysIn(snippet: string): string[] {
  const sf = ts.createSourceFile("snippet.ts", snippet, ts.ScriptTarget.ES2022, true);
  let fn: ts.FunctionLikeDeclaration | undefined;
  const visit = (n: ts.Node): void => {
    if (!fn && ts.isFunctionDeclaration(n) && n.body) fn = n;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!fn) throw new Error("snippet has no function declaration");
  return [...rawRowReadKeys(fn, sf)].sort();
}

describe("deals.is_change_order survives the query -> mapper hand-off in every raw-SQL reader", () => {
  it("counts reads off raw rows however they were bound, and off nothing else", () => {
    //  The alias hop this rule used to miss: `rows` destructured off an ALREADY-BOUND result, rather
    //  than straight off the `query()` call. No service is written this way today, which is exactly why
    //  scanning src could not have caught the gap.
    expect(
      readKeysIn(`
        async function f(tenantDb: any) {
          const result = await tenantDb.execute(sql\`SELECT d.name AS deal_name FROM deals d\`);
          const { rows } = result;
          return rows.map((row) => ({ dealName: row.deal_name, co: row.deal_is_change_order }));
        }
      `),
      "`const { rows } = result` holds the same raw rows as `result.rows`"
    ).toEqual(["deal_is_change_order"]);

    //  A Drizzle table object handed to the query builder — the first site reported as a false positive.
    expect(
      readKeysIn(`
        async function f(tenantDb: any) {
          await tenantDb.execute(sql\`SELECT 1\`);
          return tenantDb.select({ dealIsChangeOrder: deals.isChangeOrder }).from(deals)
            .groupBy(deals.isChangeOrder);
        }
      `),
      "a schema table object is an INPUT to the query, never a row of one"
    ).toEqual([]);

    //  A typed builder result indexed directly — the second site reported as a false positive.
    expect(
      readKeysIn(`
        async function f(tenantDb: any) {
          const currentDeal = await tenantDb.select().from(deals).limit(1).for("update");
          if (currentDeal[0].isChangeOrder === true) throw new Error("locked");
          await tenantDb.execute(sql\`select set_config('a', 'b', true)\`);
        }
      `),
      "`.select()...` returns typed rows that tsc already covers, not raw execute() rows"
    ).toEqual([]);

    //  Two mappers, both calling their parameter `row`, one raw and one typed. Name-based tracking let
    //  the raw one vouch for the typed one and reported correct code.
    expect(
      readKeysIn(`
        async function f(tenantDb: any) {
          const result = await tenantDb.execute(sql\`SELECT d.name AS deal_name FROM deals d\`);
          const raw = (result as any).rows ?? result;
          const typed = buildTypedRows(raw);
          return {
            a: raw.map((row) => ({ n: row.deal_name })),
            b: typed.map((row) => ({ n: row.dealName, co: row.dealIsChangeOrder })),
          };
        }
      `),
      "a shadowing `row` in a sibling mapper does not inherit the raw one's scope"
    ).toEqual([]);
  });

  it("no mapper reads a change-order key its own query never produced", () => {
    const problems = scanServerSrc().filter((p) => p.kind === "READ_WITHOUT_PROJECTION");
    expect(
      problems.map((p) => `${p.where}\n    ${p.detail}`),
      "A raw-SQL row key IS the SQL output column name. Reading one the SELECT never produced yields " +
        "undefined forever, and formatDealDisplayName then silently guesses from the deal's name."
    ).toEqual([]);
  });

  it("reports the same thing when no module type resolves", () => {
    // Filed twice as a P1 against this rule: that it counts `deals.isChangeOrder` in getProjectPhotoStats
    // and `currentDeal[0].isChangeOrder` in changeDealStage as raw-row reads. Neither is one — the first
    // is a Drizzle table object handed to `.select()`, the second a typed builder row.
    //
    // The claim was never reproducible here, and it was never nonsense either: it is exactly what the
    // earlier `any`-receiver test DID report in a checkout where `drizzle-orm` or `shared/dist` is
    // missing from the Program, because there every receiver is `any`. Whether a read is a raw ROW is a
    // property of the code, so scoping it structurally makes the two Programs agree — and this test is
    // the one that stays failing if a type-based shortcut is ever put back.
    const typeless = getTypelessProgram();
    // Breaking resolution must not also break the SCAN, or this proves nothing.
    for (const named of ["modules/files/feed-service.ts", "modules/deals/stage-change.ts"]) {
      expect(
        typeless.getSourceFiles().some((f) => f.fileName.endsWith(named)),
        `the typeless Program must still contain ${named}, the file the claim named`
      ).toBe(true);
    }
    const problems = scanServerSrc(typeless).filter((p) => p.kind === "READ_WITHOUT_PROJECTION");
    expect(
      problems.map((p) => `${p.where}\n    ${p.detail}`),
      "A query-builder input is not a result row, whether or not the checker can prove it."
    ).toEqual([]);
  }, 60000); // builds a second ts.Program over server/src

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
