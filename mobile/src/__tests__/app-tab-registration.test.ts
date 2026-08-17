import fs from "fs";
import path from "path";
import * as ts from "typescript";

/**
 * Every route under `app/(app)/` must be either a DECLARED TAB or explicitly hidden.
 *
 * Expo Router auto-adds any route file or directory under a Tabs layout as a tab. That is how
 * `dev-wearables` once shipped as a fifth tab a crew could tap into a blank screen, and how `walk` — a
 * screen that is meaningless without a deal to attach to — would have shipped as a tab bound to nothing.
 * Both are fixed by an explicit `href: null` registration, and nothing but a guard keeps the next route
 * from repeating it: adding a directory is enough, no edit to this layout required.
 *
 * The Scorecard → Reports rename made this sharper. `scorecards/` still exists as a route group so every
 * in-progress local draft and every emailed corrective-action deep link keeps resolving, but it is now
 * entered from the Reports hub. Drop its `href: null` and the app ships with two tabs that do almost the
 * same thing — and the Reports hub's own entries become dead weight.
 *
 * WHY THIS PARSES RATHER THAN GREPS. A regex over this file has to model JSX attribute order, arbitrary
 * whitespace, comments sitting between attributes, and an `options` prop that is a multi-line object with
 * a nested arrow function — and the failure mode of a regex that does not is a SILENT pass, which is the
 * one outcome a guard must never have. `mobile/` is not in CI, so this suite is the only thing that will
 * ever notice.
 */

const APP_DIR = path.join(__dirname, "..", "..", "app", "(app)");
const LAYOUT = path.join(APP_DIR, "_layout.tsx");

type Registration = { name: string; hidden: boolean; hasTitle: boolean };

function parseTabRegistrations(source: string): Registration[] {
  const file = ts.createSourceFile("_layout.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const registrations: Registration[] = [];

  function attributesOf(node: ts.Node): ts.JsxAttributes | null {
    if (ts.isJsxSelfClosingElement(node)) return node.attributes;
    if (ts.isJsxOpeningElement(node)) return node.attributes;
    return null;
  }

  function tagNameOf(node: ts.Node): string | null {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      return node.tagName.getText();
    }
    return null;
  }

  function visit(node: ts.Node): void {
    if (tagNameOf(node) === "Tabs.Screen") {
      const attributes = attributesOf(node)!;
      let name: string | null = null;
      let hidden = false;
      let hasTitle = false;

      for (const attribute of attributes.properties) {
        if (!ts.isJsxAttribute(attribute)) continue;
        const attributeName = attribute.name.getText();
        if (attributeName === "name" && attribute.initializer && ts.isStringLiteral(attribute.initializer)) {
          name = attribute.initializer.text;
        }
        if (
          attributeName === "options" &&
          attribute.initializer &&
          ts.isJsxExpression(attribute.initializer) &&
          attribute.initializer.expression &&
          ts.isObjectLiteralExpression(attribute.initializer.expression)
        ) {
          for (const property of attribute.initializer.expression.properties) {
            if (!ts.isPropertyAssignment(property)) continue;
            const key = property.name.getText();
            // `href: null` is the only value that hides a route; `href: "/x"` would still render a tab.
            if (key === "href" && property.initializer.kind === ts.SyntaxKind.NullKeyword) hidden = true;
            if (key === "title") hasTitle = true;
          }
        }
      }
      if (name) registrations.push({ name, hidden, hasTitle });
    }
    ts.forEachChild(node, visit);
  }

  visit(file);
  return registrations;
}

/** Every route name Expo Router would derive from the directory, which is what auto-registers as a tab. */
function routeNamesOnDisk(): string[] {
  return fs
    .readdirSync(APP_DIR, { withFileTypes: true })
    .map((entry) => (entry.isDirectory() ? entry.name : entry.name.replace(/\.(tsx|ts|jsx|js)$/, "")))
    .filter((name) => name !== "_layout")
    .sort();
}

describe("(app) tab registration", () => {
  const registrations = parseTabRegistrations(fs.readFileSync(LAYOUT, "utf8"));
  const byName = new Map(registrations.map((registration) => [registration.name, registration]));

  it("parses the layout at all — a zero-registration read would pass every case below vacuously", () => {
    expect(registrations.length).toBeGreaterThan(0);
  });

  it("declares exactly the four visible tabs, in tab-bar order", () => {
    expect(registrations.filter((r) => !r.hidden).map((r) => r.name)).toEqual([
      "projects",
      "capture",
      "reports",
      "profile",
    ]);
  });

  it("keeps the scorecard routes reachable but OFF the tab bar", () => {
    // Reachable: the routes still exist, so `/scorecards/<draftId>` and the emailed corrective-action
    // links resolve. Off the bar: they are entered from the Reports hub now.
    expect(byName.get("scorecards")).toEqual({ name: "scorecards", hidden: true, hasTitle: false });
    expect(fs.existsSync(path.join(APP_DIR, "scorecards", "index.tsx"))).toBe(true);
    expect(fs.existsSync(path.join(APP_DIR, "scorecards", "[draftId].tsx"))).toBe(true);
    expect(fs.existsSync(path.join(APP_DIR, "scorecards", "corrective-action", "[id].tsx"))).toBe(true);
  });

  it("names the tab Reports, pointing at the hub", () => {
    expect(byName.get("reports")?.hasTitle).toBe(true);
    expect(fs.existsSync(path.join(APP_DIR, "reports", "index.tsx"))).toBe(true);
    expect(fs.existsSync(path.join(APP_DIR, "reports", "weekly", "[draftId].tsx"))).toBe(true);
  });

  it("accounts for EVERY route on disk — a new one cannot silently become a tab", () => {
    expect(routeNamesOnDisk()).toEqual([...byName.keys()].sort());
  });
});
