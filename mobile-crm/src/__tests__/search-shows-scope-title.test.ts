import fs from "fs";
import path from "path";
import * as ts from "typescript";

/**
 * The search row has to show a deal's scope title, and only a deal's.
 *
 * `deals.scope_title` is a SEARCHED and RANKED field on the server (`server/src/modules/search/
 * unified-search.ts` matches it; `service.ts` ranks it above `description` and returns it on every deal
 * result). That makes it frequently the ONLY reason a row is in the results — most sharply for a
 * change-order child, which is stored as "<Parent> — Change Order N" and whose name therefore carries
 * no scope at all. A rep who types "Panel Relocation" and gets back a row that says nothing about panels
 * has been handed a result they cannot explain, which reads as a wrong result rather than a right one.
 * That is the same argument the row's own `tertiaryLabel` comment already makes for company names.
 *
 * Why an AST guard rather than a render test: this app's screens are the two-source-root layout
 * (`src/` and `app/`) that #958 established must be checked by PARSING, not grepping, and its suite is
 * logic- and structure-level throughout — there is no component-render harness for an expo-router screen
 * with live hooks. So this pins the three things that can silently regress, structurally.
 *
 * WHAT IT FLAGS:
 *   1. the row not rendering `scopeTitle` at all — the state this file was written to end;
 *   2. the value not being folded into the row's explicit `accessibilityLabel`. That label is
 *      hand-composed from a list, and on a Pressable it REPLACES the descendant text, so a title that is
 *      only in the JSX is invisible to VoiceOver — the discriminator a sighted rep just got, withheld
 *      from the one who needs it most;
 *   3. any use of the field that is not gated on `entityType === "deal"`. One row renders deals,
 *      contacts, files, companies, leads and properties. The field is deal-only, exactly like the CO
 *      badge above it.
 *
 * KNOWN LIMIT: syntactic and single-file. It proves the guarded reference EXISTS and is gated; it does
 * not prove the row looks right. Green here plus a green `mobile-crm` typecheck (which is what proves
 * `scopeTitle` is actually on the `SearchResult` type) is the pair.
 */

const SEARCH_SCREEN = path.resolve(__dirname, "../../app/(app)/search.tsx");
const GATE = '=== "deal"';

function parse(file: string) {
  const text = fs.readFileSync(file, "utf8");
  return {
    text,
    sourceFile: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
  };
}

/** Every `<something>.scopeTitle` property access in the file, as AST nodes. */
function scopeTitleReferences(sourceFile: ts.SourceFile): ts.PropertyAccessExpression[] {
  const found: ts.PropertyAccessExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === "scopeTitle") {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** The nearest ancestor that decides whether `node` renders at all. */
function enclosingGuard(node: ts.Node): ts.Node | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isConditionalExpression(current) ||
      (ts.isBinaryExpression(current) &&
        current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
    ) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

describe("the mobile search row explains a scope-title match", () => {
  const { text, sourceFile } = parse(SEARCH_SCREEN);
  const references = scopeTitleReferences(sourceFile);

  it("reads scopeTitle at all", () => {
    // The state this guard exists to end: the server returns the field and the row ignored it.
    expect(references.length).toBeGreaterThan(0);
  });

  it("renders it inside a <Text>, not only in a prop", () => {
    const insideText = references.some((reference) => {
      let current: ts.Node | undefined = reference.parent;
      while (current) {
        if (ts.isJsxElement(current) && current.openingElement.tagName.getText() === "Text") {
          return true;
        }
        current = current.parent;
      }
      return false;
    });
    expect(insideText).toBe(true);
  });

  it("folds it into the row's hand-composed accessibilityLabel", () => {
    // The Pressable's accessibilityLabel OVERRIDES its descendant text, so a title present only in the
    // JSX is spoken to nobody. Find the attribute and assert the field is named inside it.
    let labelText: string | null = null;
    const visit = (node: ts.Node) => {
      if (ts.isJsxAttribute(node) && node.name.getText() === "accessibilityLabel" && node.initializer) {
        labelText = node.initializer.getText();
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    expect(labelText).not.toBeNull();
    expect(labelText!).toContain("scopeTitle");
  });

  it("gates EVERY use on a deal, because one row renders six entity types", () => {
    // A file result legitimately named for a scope is still not a deal's scope_title, and the field is
    // absent from every non-deal payload — an ungated read would render `undefined`-shaped rows at best
    // and mislabel a file at worst.
    expect(references.length).toBeGreaterThan(0);
    // Collected rather than asserted one at a time, so a failure NAMES every ungated site at once
    // instead of stopping at the first (jest's expect takes no message argument).
    const ungated = references
      .filter((reference) => {
        const guard = enclosingGuard(reference);
        return guard === null || !guard.getText().includes(GATE);
      })
      .map((reference) => reference.getText());

    expect(ungated).toEqual([]);
  });

  it("keeps the title ABOVE the meta line, where the matched field belongs", () => {
    // Ordering is the whole point: the reason the row matched should be read before the number and the
    // city. Positional, so a later refactor that drops it below the meta line is caught.
    const titleAt = text.indexOf("search-scope-title");
    const metaAt = text.indexOf("styles.rowMeta");
    expect(titleAt).toBeGreaterThan(-1);
    expect(metaAt).toBeGreaterThan(-1);
    expect(titleAt).toBeLessThan(metaAt);
  });
});
