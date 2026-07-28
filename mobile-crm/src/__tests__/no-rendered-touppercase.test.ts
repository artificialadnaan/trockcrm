import fs from "fs";
import path from "path";
import * as ts from "typescript";

/**
 * Tree-wide guard: uppercase is a STYLE, never a string operation on rendered text.
 *
 * VoiceOver reads a short all-caps string as an initialism — "WON" becomes "W-O-N", a stage tab reads
 * letter by letter, and the board's scope segments ("MINE", "ALL") stop being words. `textTransform:
 * "uppercase"` changes only the glyphs drawn; the accessible name stays "Won", so the same screen looks
 * identical and reads correctly. `String.toUpperCase()` changes the text itself and there is no way to
 * recover the original downstream.
 *
 * Three sites shipped in #976 before this existed — the scope segments, the stage tabs, and the column
 * summary — and all three passed review and a green build, because nothing about them looks wrong in a
 * diff. That is what this file is for.
 *
 * WHAT IT FLAGS: a `.toUpperCase()` call that is reachable from JSX — inside a JSX expression container
 * (`{x.toUpperCase()}`) or a JSX attribute (`accessibilityLabel={x.toUpperCase()}`). That is the exact
 * shape that reaches a screen reader.
 *
 * WHAT IT DELIBERATELY ALLOWS, because none of it is displayed as shouted text:
 *   - normalisation and comparison — `method.toUpperCase()` when building a request header;
 *   - title-casing helpers — `s.charAt(0).toUpperCase() + s.slice(1)`, which produces "Site visit",
 *     not "SITE VISIT", and is a different operation that happens to share a method name.
 * Both live in ordinary functions, so restricting the check to JSX separates them structurally rather
 * than by maintaining a list of blessed filenames.
 *
 * WHY IT PARSES INSTEAD OF GREPPING. `grep toUpperCase` cannot tell a header from a label, and its
 * failure mode is the dangerous direction: a guard that cannot classify tends to get an allowlist, and
 * an allowlist entry is permanent. Against a syntax tree the question "is this call inside JSX?" is a
 * walk up the parent chain. A file that fails to parse is reported as a FAILURE rather than skipped —
 * silently dropping unparseable input is fail-open, which is how a sibling guard was disarmed by a
 * comment sitting in the wrong place (#958).
 *
 * KNOWN LIMIT: single-file and syntactic. A helper that uppercases and is rendered elsewhere is not
 * caught. Green means "no direct route", not a proof.
 */

const ROOT = path.resolve(__dirname, "../..");
const SCAN_DIRS = ["src", "app"];
const EXTS = new Set([".ts", ".tsx"]);

function sourceFiles(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(abs, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path.join(dir, entry.name)));
    else if (EXTS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

/** True when the node sits inside rendered JSX — an expression container or an attribute value. */
function isInsideJsx(node: ts.Node): boolean {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (ts.isJsxExpression(cur) || ts.isJsxAttribute(cur)) return true;
    // A function boundary ends the search: a callback defined inside JSX (an onPress handler) is not
    // itself rendered, and its uppercase would be normalisation rather than display.
    if (ts.isFunctionDeclaration(cur) || ts.isMethodDeclaration(cur)) return false;
  }
  return false;
}

function findings(file: string): string[] {
  const text = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  // A parse failure must FAIL, not skip — a guard that silently drops what it cannot read is worse
  // than no guard, because the green tick still gets reported.
  const syntactic = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (syntactic.length > 0) {
    return [`${path.relative(ROOT, file)}: could not be parsed (${syntactic.length} syntax errors)`];
  }

  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "toUpperCase" &&
      isInsideJsx(node)
    ) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      hits.push(`${path.relative(ROOT, file)}:${line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

describe("no toUpperCase() on rendered text", () => {
  it("scans a non-trivial number of files, so a broken walker cannot pass as clean", () => {
    // Without this, a bug in sourceFiles() that returns [] makes the guard below vacuously green.
    expect(SCAN_DIRS.flatMap(sourceFiles).length).toBeGreaterThan(20);
  });

  it("finds no uppercase string operations inside JSX", () => {
    const all = SCAN_DIRS.flatMap(sourceFiles).flatMap(findings);
    expect(all).toEqual([]);
  });

  describe("the check itself", () => {
    const check = (src: string) => {
      const file = path.join(ROOT, "app", "__probe__.tsx");
      const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const hits: string[] = [];
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "toUpperCase" &&
          isInsideJsx(node)
        ) {
          hits.push("hit");
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
      return hits.length;
    };

    it("catches the form that shipped", () => {
      expect(check("const A = () => <Text>{s.label.toUpperCase()}</Text>;")).toBe(1);
    });

    it("catches it in an accessibility attribute, where it matters most", () => {
      expect(check("const A = () => <Text accessibilityLabel={s.name.toUpperCase()}>x</Text>;")).toBe(1);
    });

    it("catches it nested in a template or a concatenation", () => {
      expect(check("const A = () => <Text>{`${s.name.toUpperCase()} · Total`}</Text>;")).toBe(1);
      expect(check("const A = () => <Text>{s.name.toUpperCase() + ' · Total'}</Text>;")).toBe(1);
    });

    it("allows normalisation outside JSX", () => {
      expect(check("const h = (m: string) => { if (SAFE.has(m.toUpperCase())) return 1; return 0; };")).toBe(0);
    });

    it("allows a title-casing helper", () => {
      expect(check("function cap(s: string) { return s.charAt(0).toUpperCase() + s.slice(1); }")).toBe(0);
    });

    it("is not fooled by the identifier appearing in a comment", () => {
      expect(check("const A = () => <Text>{/* toUpperCase() is banned here */ s.label}</Text>;")).toBe(0);
    });
  });
});
