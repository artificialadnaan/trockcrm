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
 * WHAT IT FLAGS: a control whose style declares no `minHeight`/`height` of at least 44.
 *
 * THE VERTICAL DIMENSION ONLY, and the name is a promise about that rather than about 44x44. Width is
 * not checked because it is usually not declared: these controls are either full-width by `flex`, or
 * content-width by `alignSelf`, and both are resolved by layout rather than by a style a static pass can
 * read. Height is the dimension that was actually failing — an ~18pt back link is full-bleed wide — so
 * this enforces the half that is both checkable and broken. A narrow icon-only control could still pass
 * while under 44 across; there is none in this app today, and one would need `minWidth` written down.
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

/**
 * Everything a finger is meant to land on.
 *
 * `TextInput` belongs here even though it takes no `onPress`: a credential field or a search box is a
 * touch target like any other, and `formStyles.input` computed to about 43pt from padding alone — under
 * the floor, and invisible to a guard that only looked at Pressables.
 */
const CONTROL_TAGS = new Set([
  "Pressable",
  "TouchableOpacity",
  "TouchableHighlight",
  "TouchableWithoutFeedback",
  "TextInput",
]);

/**
 * Style entries in this file that declare a height floor, QUALIFIED by the object that owns them.
 *
 * "styles.retryBtn", not "retryBtn". Matching on the bare key made every floor global: because
 * `formStyles.button` contributes `button`, an unrelated local `styles.button` with no floor at all was
 * silently accepted, and two local objects could shadow each other the same way. The owner is the
 * variable the StyleSheet (or plain object) is assigned to, which is exactly what the JSX writes.
 */
function keysMeetingFloor(sf: ts.SourceFile): Map<string, number> {
  const heights = new Map<string, number>();
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node)) {
      const name = ts.isIdentifier(node.name) ? node.name.text : node.name.getText();
      if ((name === "minHeight" || name === "height") && ts.isNumericLiteral(node.initializer)) {
        const entry = node.parent?.parent;
        if (entry && ts.isPropertyAssignment(entry)) {
          const key = ts.isIdentifier(entry.name) ? entry.name.text : entry.name.getText();
          const owner = owningVariable(entry);
          // The VALUE, including values under the floor: last-wins flattening means a later
          // under-floor entry cancels an earlier good one, so the small ones have to be visible here.
          if (owner) heights.set(`${owner}.${key}`, Number(node.initializer.text));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return heights;
}

/** The variable a style entry ultimately belongs to — `const styles = StyleSheet.create({ ... })`. */
function owningVariable(entry: ts.Node): string | null {
  for (let cur: ts.Node | undefined = entry.parent; cur; cur = cur.parent) {
    if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) return cur.name.text;
  }
  return null;
}

/**
 * Floor-meeting keys from the one module that exports finished controls.
 *
 * Read once and memoised. A missing file yields an empty set rather than throwing: the guard then
 * reports the two form buttons, which is a loud, correct failure — quietly passing them would not be.
 */
let sharedCache: Map<string, number> | null = null;
function sharedFloorKeys(): Map<string, number> {
  if (sharedCache) return sharedCache;
  const file = path.join(ROOT, "src", "theme", "formStyles.ts");
  if (!fs.existsSync(file)) return (sharedCache = new Map());
  const sf = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  return (sharedCache = keysMeetingFloor(sf));
}

/**
 * Is this reference in a position that ALWAYS applies?
 *
 * `style={[styles.small, selected && styles.big]}` used to pass because the walk found a floor
 * somewhere in the expression — but the floor only arrives when `selected` is true, so the ordinary
 * unselected control stayed undersized. The scope-pill and active-state arrays all over these screens
 * are exactly that shape. A floor that depends on state is not a floor.
 */
function isUnconditional(node: ts.Node, root: ts.Node): boolean {
  for (let cur: ts.Node | undefined = node; cur && cur !== root; cur = cur.parent) {
    const p: ts.Node | undefined = cur.parent;
    if (!p) break;
    // Statement-level branches too. `style={({pressed}) => { if (pressed) return styles.big; return
    // styles.small; }}` is the same defect wearing a block body, and only expression forms were caught.
    if (ts.isIfStatement(p) && (p.thenStatement === cur || p.elseStatement === cur)) return false;
    if (ts.isCaseClause(p) || ts.isDefaultClause(p)) return false;
    if (ts.isConditionalExpression(p) && (p.whenTrue === cur || p.whenFalse === cur)) return false;
    if (ts.isBinaryExpression(p)) {
      const k = p.operatorToken.kind;
      if (
        k === ts.SyntaxKind.AmpersandAmpersandToken ||
        k === ts.SyntaxKind.BarBarToken ||
        k === ts.SyntaxKind.QuestionQuestionToken
      ) {
        return false;
      }
    }
  }
  return true;
}

/**
 * The height this style expression actually resolves to, or null when nothing declares one.
 *
 * RN flattens a style array LAST-WINS, so `[styles.big, styles.compact]` is 32 when `compact` says 32,
 * however large `big` is. An earlier version returned true on the first floor it met and never looked
 * further, which reported that pair as compliant. Declarations are therefore collected in SOURCE ORDER
 * and the last one decides.
 *
 * A CONDITIONAL declaration cannot raise the floor — it is absent when its condition is false — but it
 * can lower it, because when the condition holds it wins like any other. So a conditional entry counts
 * only when it is under the floor. That asymmetry is deliberate: both directions err toward reporting.
 */
function resolvedFloor(node: ts.Node, heights: Map<string, number>): number | null {
  const found: { value: number; conditional: boolean }[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression)) {
      const value = heights.get(`${n.expression.text}.${n.name.text}`);
      if (value !== undefined) found.push({ value, conditional: !isUnconditional(n, node) });
    }
    if (ts.isPropertyAssignment(n)) {
      const name = ts.isIdentifier(n.name) ? n.name.text : n.name.getText();
      if ((name === "minHeight" || name === "height") && ts.isNumericLiteral(n.initializer)) {
        found.push({
          value: Number(n.initializer.text),
          conditional: !isUnconditional(n, node),
        });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  if (found.length === 0) return null;

  let floor: number | null = null;
  for (const d of found) {
    if (!d.conditional) floor = d.value;
    // A conditional entry can only make things worse; when it applies, it is the last word.
    else if (d.value < FLOOR) floor = d.value;
  }
  return floor;
}

function declaresFloor(node: ts.Node, heights: Map<string, number>): boolean {
  const floor = resolvedFloor(node, heights);
  return floor !== null && floor >= FLOOR;
}

function findings(file: string): string[] {
  const text = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const syntactic = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (syntactic.length > 0) {
    return [`${path.relative(ROOT, file)}: could not be parsed (${syntactic.length} syntax errors)`];
  }

  const floorKeys = new Map([...keysMeetingFloor(sf), ...sharedFloorKeys()]);
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    const open = ts.isJsxElement(node)
      ? node.openingElement
      : ts.isJsxSelfClosingElement(node)
        ? node
        : undefined;
    if (open && CONTROL_TAGS.has(open.tagName.getText())) {
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
        if (open && CONTROL_TAGS.has(open.tagName.getText())) {
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

    it("rejects a floor that only arrives in a CONDITIONAL branch", () => {
      // `[styles.small, selected && styles.big]` used to pass, leaving the ordinary unselected control
      // undersized — and active/inactive arrays are how every pill on these screens is written. A floor
      // that depends on state is not a floor.
      expect(
        check(`${SHEET} const A = () => <Pressable style={[styles.small, on && styles.big]} />;`),
      ).toBe(1);
      expect(
        check(`${SHEET} const A = () => <Pressable style={[styles.small, on ? styles.big : null]} />;`),
      ).toBe(1);
    });

    it("still accepts a conditional style ALONGSIDE an unconditional floor", () => {
      expect(
        check(`${SHEET} const A = () => <Pressable style={[styles.big, on && styles.small]} />;`),
      ).toBe(0);
    });

    it("does not let one object's floor vouch for another object's key", () => {
      // `formStyles.button` contributes a floor; a local `styles.button` with none must still fail.
      // Matching on the bare key made every floor global.
      expect(
        check(
          "const formStyles = StyleSheet.create({ button: { minHeight: 44 } });" +
            " const styles = StyleSheet.create({ button: { paddingVertical: 8 } });" +
            " const A = () => <Pressable style={styles.button} />;",
        ),
      ).toBe(1);
    });

    it("respects last-wins flattening — a later entry can cancel the floor", () => {
      // RN flattens a style array last-wins, so [big, compact] is 32 when compact says 32, however
      // large big is. Returning true on the first floor met reported that pair as compliant.
      const SHEET2 =
        "const styles = StyleSheet.create({ big: { minHeight: 44 }, compact: { minHeight: 32 } });";
      expect(check(`${SHEET2} const A = () => <Pressable style={[styles.big, styles.compact]} />;`)).toBe(1);
      expect(check(`${SHEET2} const A = () => <Pressable style={[styles.compact, styles.big]} />;`)).toBe(0);
    });

    it("treats a CONDITIONAL under-floor override as applying", () => {
      // A conditional entry cannot raise the floor, but it can lower it — when its condition holds it
      // wins like any other. Both directions err toward reporting.
      const SHEET2 =
        "const styles = StyleSheet.create({ big: { minHeight: 44 }, compact: { minHeight: 32 } });";
      expect(
        check(`${SHEET2} const A = () => <Pressable style={[styles.big, dense && styles.compact]} />;`),
      ).toBe(1);
    });

    it("catches a floor that only appears in one branch of a STATEMENT body", () => {
      // The block-bodied twin of the ternary case. Only expression forms were recognised.
      expect(
        check(
          `${SHEET} const A = () => <Pressable style={({ pressed }) => { if (pressed) return styles.big; return styles.small; }} />;`,
        ),
      ).toBe(1);
    });

    it("scans TextInput too — a credential field is a touch target", () => {
      expect(check(`${SHEET} const A = () => <TextInput style={styles.small} />;`)).toBe(1);
      expect(check(`${SHEET} const A = () => <TextInput style={styles.big} />;`)).toBe(0);
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
