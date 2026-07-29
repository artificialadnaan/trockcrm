import fs from "fs";
import path from "path";
import * as ts from "typescript";

/**
 * Every control declares a 44pt floor.
 *
 * Apple's HIG minimum is 44x44pt, and this app's stated user is a rep in gloves on a roof. The rule was
 * already known here — `board.tsx` comments on the HIG minimum, and `prospect.tsx` sets an explicit
 * `minHeight` on all eighteen of its controls — but it was learned inside two PRs and stopped at their
 * file boundaries. On the screens opened most, back links were a bare text line (~18pt), and the stage,
 * close-date and lost-reason pickers on the move screen — its entire primary interaction — sat at ~32pt.
 *
 * WHY A DECLARED FLOOR RATHER THAN A COMPUTED HEIGHT. The honest way to measure a rendered control is to
 * render it; everything else is padding plus a guess at the font's line box. The review that prompted
 * this had to estimate, and said so — the 40.8pt cluster could have been 42 or 39 and no static pass can
 * tell. `minHeight: 44` needs no estimate. It is exact, it is visible in a diff, and it cannot be
 * wrong. So this checks that the floor is STATED, not that some arithmetic reaches it.
 *
 * WHY `hitSlop` DOES NOT EXEMPT. It is a real mechanism and several controls here use it correctly, but
 * it enlarges only the touch region: the thing a rep aims at in sunlight is still the drawn control, and
 * `hitSlop={8}` on a text line reaches 34pt, not 44. Allowing it as a substitute would also make the
 * rule two rules, one of which needs the font metrics this deliberately avoids. Keep the hitSlop where
 * it helps — it stacks — but declare the floor too.
 *
 * WHAT IT FLAGS: a Pressable/Touchable whose style declares no `minHeight`/`height` of at least 44.
 *
 * WHAT IT ALLOWS: any of the element's styles reaching the floor — array forms, `({ pressed }) => [...]`
 * callbacks, and inline objects are all searched, because a control only has to be big once.
 *
 * SHARED STYLES: `src/theme/formStyles.ts` is read too, because it is the one module that hands finished
 * controls to other files — `formStyles.button` IS the login and change-password submit. Treating it as
 * unresolvable would have forced a duplicate `minHeight` into both screens, which is the duplication
 * that module exists to end. Any OTHER cross-file style stays unresolved and its element is flagged
 * until it declares a floor locally; that is the safe direction — a visible false positive, fixed by
 * writing the number down where the control is.
 */

const ROOT = path.resolve(__dirname, "../..");
const SCAN_DIRS = ["src", "app"];
const EXTS = new Set([".tsx"]);
const FLOOR = 44;

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

function attr(el: ts.JsxOpeningElement | ts.JsxSelfClosingElement, name: string): ts.JsxAttribute | undefined {
  for (const a of el.attributes.properties) {
    if (!ts.isJsxAttribute(a)) continue;
    const n = ts.isIdentifier(a.name) ? a.name.text : a.name.getText();
    if (n === name) return a;
  }
  return undefined;
}

const PRESSABLE_TAGS = new Set([
  "Pressable",
  "TouchableOpacity",
  "TouchableHighlight",
  "TouchableWithoutFeedback",
]);

/** Style keys in this file that declare a height floor of at least 44. */
function keysMeetingFloor(sf: ts.SourceFile): Set<string> {
  const keys = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node)) {
      const name = ts.isIdentifier(node.name) ? node.name.text : node.name.getText();
      if (
        (name === "minHeight" || name === "height") &&
        ts.isNumericLiteral(node.initializer) &&
        Number(node.initializer.text) >= FLOOR
      ) {
        const entry = node.parent?.parent;
        if (entry && ts.isPropertyAssignment(entry)) {
          keys.add(ts.isIdentifier(entry.name) ? entry.name.text : entry.name.getText());
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return keys;
}

/**
 * Floor-meeting keys from the one module that exports finished controls.
 *
 * Read once and memoised. A missing file yields an empty set rather than throwing: the guard then
 * reports the two form buttons, which is a loud, correct failure — quietly passing them would not be.
 */
let sharedCache: Set<string> | null = null;
function sharedFloorKeys(): Set<string> {
  if (sharedCache) return sharedCache;
  const file = path.join(ROOT, "src", "theme", "formStyles.ts");
  if (!fs.existsSync(file)) return (sharedCache = new Set());
  const sf = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  return (sharedCache = keysMeetingFloor(sf));
}

/** Does this style expression reach the floor — via a named style, or inline? */
function declaresFloor(node: ts.Node, floorKeys: Set<string>): boolean {
  let ok = false;
  const visit = (n: ts.Node): void => {
    if (ok) return;
    if (ts.isPropertyAccessExpression(n) && floorKeys.has(n.name.text)) ok = true;
    if (ts.isPropertyAssignment(n)) {
      const name = ts.isIdentifier(n.name) ? n.name.text : n.name.getText();
      if (
        (name === "minHeight" || name === "height") &&
        ts.isNumericLiteral(n.initializer) &&
        Number(n.initializer.text) >= FLOOR
      ) {
        ok = true;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return ok;
}

function findings(file: string): string[] {
  const text = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const syntactic = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (syntactic.length > 0) {
    return [`${path.relative(ROOT, file)}: could not be parsed (${syntactic.length} syntax errors)`];
  }

  const floorKeys = new Set([...keysMeetingFloor(sf), ...sharedFloorKeys()]);
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    const open = ts.isJsxElement(node)
      ? node.openingElement
      : ts.isJsxSelfClosingElement(node)
        ? node
        : undefined;
    if (open && PRESSABLE_TAGS.has(open.tagName.getText())) {
      const style = attr(open, "style");
      const ok = style?.initializer ? declaresFloor(style.initializer, floorKeys) : false;
      if (!ok) {
        const { line } = sf.getLineAndCharacterOfPosition(open.getStart(sf));
        hits.push(`${path.relative(ROOT, file)}:${line + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

describe("interactive controls declare a 44pt floor", () => {
  it("scans a non-trivial number of files, so a broken walker cannot pass as clean", () => {
    expect(SCAN_DIRS.flatMap(sourceFiles).length).toBeGreaterThan(20);
  });

  it("finds no control without a declared floor", () => {
    const all = SCAN_DIRS.flatMap(sourceFiles).flatMap(findings);
    expect(all).toEqual([]);
  });

  describe("the check itself", () => {
    const check = (src: string) => {
      const file = path.join(ROOT, "app", "__probe__.tsx");
      const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const floorKeys = keysMeetingFloor(sf);
      const hits: string[] = [];
      const visit = (node: ts.Node): void => {
        const open = ts.isJsxElement(node)
          ? node.openingElement
          : ts.isJsxSelfClosingElement(node)
            ? node
            : undefined;
        if (open && PRESSABLE_TAGS.has(open.tagName.getText())) {
          const style = attr(open, "style");
          if (!(style?.initializer && declaresFloor(style.initializer, floorKeys))) hits.push("hit");
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
      return hits.length;
    };

    const SHEET =
      "const styles = StyleSheet.create({ big: { minHeight: 44 }, tall: { height: 48 }, small: { paddingVertical: 8 } });";

    it("catches a control with no style at all — the bare-text back links", () => {
      expect(check("const A = () => <Pressable onPress={go}><Text>‹ Deals</Text></Pressable>;")).toBe(1);
    });

    it("catches a control styled only with padding", () => {
      expect(check(`${SHEET} const A = () => <Pressable style={styles.small} />;`)).toBe(1);
    });

    it("passes a declared minHeight", () => {
      expect(check(`${SHEET} const A = () => <Pressable style={styles.big} />;`)).toBe(0);
    });

    it("passes a fixed height at the floor", () => {
      expect(check(`${SHEET} const A = () => <Pressable style={styles.tall} />;`)).toBe(0);
    });

    it("finds the floor anywhere in an array — a control only has to be big once", () => {
      expect(check(`${SHEET} const A = () => <Pressable style={[styles.small, styles.big]} />;`)).toBe(0);
    });

    it("looks inside a style CALLBACK, which is how the board cards are written", () => {
      expect(
        check(`${SHEET} const A = () => <Pressable style={({ pressed }) => [styles.big, pressed && styles.small]} />;`),
      ).toBe(0);
    });

    it("accepts an inline floor", () => {
      expect(check("const A = () => <Pressable style={{ minHeight: 44 }} />;")).toBe(0);
    });

    it("rejects a floor below 44", () => {
      expect(
        check("const s = StyleSheet.create({ x: { minHeight: 36 } }); const A = () => <Pressable style={s.x} />;"),
      ).toBe(1);
    });

    it("does NOT let hitSlop stand in for the floor", () => {
      // It enlarges the touch region, not the thing a gloved rep aims at. Keep it; declare the floor too.
      expect(check("const A = () => <Pressable hitSlop={8}><Text>‹ Board</Text></Pressable>;")).toBe(1);
    });

    it("ignores non-interactive elements", () => {
      expect(check("const A = () => <View><Text>x</Text></View>;")).toBe(0);
    });
  });
});
