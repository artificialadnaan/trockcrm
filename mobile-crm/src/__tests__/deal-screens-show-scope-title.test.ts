import fs from "fs";
import path from "path";
import * as ts from "typescript";

/**
 * The scope title has to survive LEAVING search.
 *
 * #1051 put `scopeTitle` on the mobile search row and nowhere else in this app. Following that result,
 * or reaching the same deal from the Deals tab or the board, dropped it: `DealListItem` did not declare
 * the field, `DealCard` never rendered it, and the detail screen never rendered it. So the one phrase
 * that explained why a row matched vanished at the moment the user acted on it — and a change-order
 * child, stored as "<Parent> — Change Order N", became indistinguishable from its parent and from its
 * siblings on every screen except the one they came from.
 *
 * Why an AST guard rather than a render test: same reason as search-shows-scope-title.test.ts — this
 * app is the two-source-root layout (`src/` and `app/`) that #958 established must be checked by
 * PARSING, not grepping, and there is no component-render harness for these screens.
 *
 * WHAT IT FLAGS, per screen:
 *   1. the field not being read at all — the state this file was written to end;
 *   2. it being rendered in JSX but left out of the CARD's hand-composed `accessibilityLabel`. That
 *      label sits on a Pressable, where it REPLACES all descendant text, so a title present only in the
 *      JSX is spoken to nobody. The card's own docblock records that this exact trap was already sprung
 *      once, on the "Yours" badge — this is the guard that keeps it from being sprung a third time.
 *
 * KNOWN LIMIT: syntactic and per-file. It proves the reference exists and is announced; it does not
 * prove the screen looks right. Green here plus a green `mobile-crm` typecheck — which is what proves
 * `scopeTitle` is actually on `DealListItem`, and so on `DealDetail`, which extends it — is the pair.
 */

const DEAL_CARD = path.resolve(__dirname, "../components/DealCard.tsx");
const DEAL_DETAIL = path.resolve(__dirname, "../../app/(app)/deals/[id].tsx");

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

/** True when `node` is somewhere inside a `<Text>` element. */
function insideTextElement(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isJsxElement(current) && current.openingElement.tagName.getText() === "Text") return true;
    current = current.parent;
  }
  return false;
}

/** The text of every hand-composed `accessibilityLabel` attribute in the file. */
function accessibilityLabels(sourceFile: ts.SourceFile): string[] {
  const labels: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && node.name.getText() === "accessibilityLabel" && node.initializer) {
      labels.push(node.initializer.getText());
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return labels;
}

describe("DealCard shows the scope title", () => {
  const { text, sourceFile } = parse(DEAL_CARD);
  const references = scopeTitleReferences(sourceFile);

  it("reads scopeTitle at all", () => {
    expect(references.length).toBeGreaterThan(0);
  });

  it("renders it inside a <Text>, not only in a prop", () => {
    expect(references.some(insideTextElement)).toBe(true);
  });

  it("folds it into the card's hand-composed accessibilityLabel", () => {
    // THE trap this file exists for. The card's docblock: "anything omitted here becomes unreachable
    // rather than merely unannounced". For a change order the title is the ONLY thing distinguishing
    // this card from its siblings, so omitting it leaves the card's one identifying detail unspoken.
    const labels = accessibilityLabels(sourceFile);
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.some((label) => label.includes("scopeTitle"))).toBe(true);
  });

  it("places the title above the company line, matching the label order", () => {
    // The spoken label lists name → scope title → company. A JSX order that disagreed with it would
    // read one way and sound another; positional, so a later reshuffle is caught.
    const titleAt = text.indexOf("cardScopeTitle");
    const companyAt = text.indexOf("styles.cardCompany");
    expect(titleAt).toBeGreaterThan(-1);
    expect(companyAt).toBeGreaterThan(-1);
    expect(titleAt).toBeLessThan(companyAt);
  });
});

describe("the deal detail screen shows the scope title", () => {
  const { sourceFile } = parse(DEAL_DETAIL);
  const references = scopeTitleReferences(sourceFile);

  it("reads scopeTitle at all", () => {
    // The screen a search result LANDS on. Without this, the field that explained the match is gone
    // one tap after it was shown.
    expect(references.length).toBeGreaterThan(0);
  });

  it("renders it inside a <Text>, not only in a prop", () => {
    expect(references.some(insideTextElement)).toBe(true);
  });
});
