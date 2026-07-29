import fs from "fs";
import path from "path";
import * as ts from "typescript";

/**
 * The other half of the uppercase rule.
 *
 * `no-rendered-touppercase.test.ts` bans the STRING operation, and its docblock states the reason this
 * file exists: drawing caps correctly needs BOTH `textTransform: "uppercase"` in the style AND an
 * explicit mixed-case `accessibilityLabel`, because on iOS RN 0.81.5 `RCTAttributedTextUtils.mm` applies
 * the transform BEFORE building the attributed string and `RCTParagraphComponentView.accessibilityLabel`
 * falls back to `self.attributedText.string`. VoiceOver therefore speaks the TRANSFORMED text — "O-N
 * H-O-L-D" — unless a label overrides that fallback.
 *
 * That sibling guard names the missing label as a KNOWN LIMIT it cannot check ("that is a judgement this
 * cannot make"). It can, structurally, and this is it: banning `.toUpperCase()` only preserved the
 * mixed-case original so a label was POSSIBLE. Nothing yet required anyone to write one.
 *
 * The gap was not theoretical. #981 fixed the three board sites by hand and added the string guard;
 * thirteen other uppercase `<Text>` nodes across nine files were never touched, including every status
 * badge, the section titles on all three detail screens, and all five form labels on the move screen.
 * `Badge.tsx` additionally carried a comment asserting the OPPOSITE of the platform behaviour — that the
 * transform "stays presentational and the accessible name keeps its natural case" — which is how twelve
 * of those sites passed review: the reasoning had already been written down, and it was wrong.
 *
 * WHAT IT FLAGS: a `<Text>` whose resolved style carries `textTransform: "uppercase"` and which has no
 * `accessibilityLabel`.
 *
 * WHAT IT ALLOWS: `accessibilityElementsHidden` / `importantForAccessibility="no-hide-descendants"`, and
 * a Text nested inside an element that supplies the accessible name itself (`accessible` with a label on
 * the parent Pressable) — in both cases the fragment is not independently announced.
 *
 * KNOWN LIMIT: single-file and syntactic, like its sibling. A style object imported from another module
 * (`formStyles`) is not resolved, so a transform declared there and consumed here is invisible. Neither
 * `formStyles.ts` nor `theme.type` currently declares one — the token deliberately omits it, which
 * `Row.tsx:31-33` explains — so the blind spot is empty today rather than tolerated. Green means "no
 * unlabelled uppercase Text with a locally-declared style", not a proof.
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

/**
 * Style keys in this file whose value sets `textTransform: "uppercase"`.
 *
 * Keyed by the PROPERTY NAME rather than by the `StyleSheet.create` call, so a style held in a plain
 * object literal counts too. The walk finds the `textTransform` assignment and then climbs to the
 * enclosing entry — `{ label: { ...caption, textTransform: "uppercase" } }` yields "label".
 */
function uppercaseStyleKeys(sf: ts.SourceFile): Set<string> {
  const keys = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) ? node.name.text : node.name.getText()) === "textTransform" &&
      ts.isStringLiteralLike(node.initializer) &&
      node.initializer.text === "uppercase"
    ) {
      // node -> ObjectLiteral (the style body) -> PropertyAssignment (the style's own name)
      const body = node.parent;
      const entry = body?.parent;
      if (entry && ts.isPropertyAssignment(entry)) {
        keys.add(ts.isIdentifier(entry.name) ? entry.name.text : entry.name.getText());
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return keys;
}

/** Every `X.y` property name mentioned anywhere inside a style expression, including array forms. */
function referencedStyleNames(node: ts.Node): string[] {
  const names: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAccessExpression(n)) names.push(n.name.text);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return names;
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
 * Elements that group their subtree into ONE accessibility element without being told to.
 *
 * RN's `Pressable` and the `Touchable*` family pass `accessible={true}` by default, so a card whose
 * outer Pressable carries a label speaks once, with that label, and its children's own strings are never
 * reached. `View` does not — `accessible` is false there unless set — so a plain `<View
 * accessibilityLabel>` does NOT suppress the transformed text underneath it.
 *
 * Getting this wrong is not a small matter of taste: the first draft required an explicit `accessible`
 * prop and therefore reported `DealCard`, `LeadCard` and `BoardCard`, all three of which already label
 * the whole card correctly. A guard that cries wolf on the sites that got it RIGHT is one that gets
 * suppressed.
 */
const GROUPS_BY_DEFAULT = new Set([
  "Pressable",
  "TouchableOpacity",
  "TouchableHighlight",
  "TouchableWithoutFeedback",
  "Button",
]);

/**
 * True when this Text is not announced as a fragment of its own.
 *
 * Either it is hidden outright, or an ancestor speaks for the whole subtree — which needs a label AND
 * grouping, the latter either explicit (`accessible`) or inherent (the set above). An ancestor that
 * groups but carries NO label of its own is not exempt: RN then composes the name from the descendants'
 * text, which is the transformed string again.
 */
function coveredByAncestor(el: ts.JsxOpeningElement | ts.JsxSelfClosingElement): boolean {
  if (attr(el, "accessibilityElementsHidden") || attr(el, "importantForAccessibility")) return true;
  for (let cur: ts.Node | undefined = el.parent; cur; cur = cur.parent) {
    const open = ts.isJsxElement(cur)
      ? cur.openingElement
      : ts.isJsxSelfClosingElement(cur)
        ? cur
        : undefined;
    if (!open) continue;
    if (attr(open, "accessibilityElementsHidden")) return true;
    const groups = attr(open, "accessible") || GROUPS_BY_DEFAULT.has(open.tagName.getText());
    if (groups && attr(open, "accessibilityLabel")) return true;
  }
  return false;
}

function findings(file: string): string[] {
  const text = fs.readFileSync(file, "utf8");
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  // A parse failure FAILS rather than skips, for the reason the sibling guard gives: a guard that
  // silently drops what it cannot read still reports green (#958).
  const syntactic = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (syntactic.length > 0) {
    return [`${path.relative(ROOT, file)}: could not be parsed (${syntactic.length} syntax errors)`];
  }

  const upper = uppercaseStyleKeys(sf);
  if (upper.size === 0) return [];

  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    const open = ts.isJsxElement(node)
      ? node.openingElement
      : ts.isJsxSelfClosingElement(node)
        ? node
        : undefined;
    if (open && open.tagName.getText() === "Text") {
      const style = attr(open, "style");
      const used = style?.initializer ? referencedStyleNames(style.initializer) : [];
      if (used.some((n) => upper.has(n)) && !attr(open, "accessibilityLabel") && !coveredByAncestor(open)) {
        const { line } = sf.getLineAndCharacterOfPosition(open.getStart(sf));
        hits.push(`${path.relative(ROOT, file)}:${line + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

describe("uppercase Text carries an explicit accessibilityLabel", () => {
  it("scans a non-trivial number of files, so a broken walker cannot pass as clean", () => {
    expect(SCAN_DIRS.flatMap(sourceFiles).length).toBeGreaterThan(20);
  });

  it("finds no unlabelled uppercase Text", () => {
    const all = SCAN_DIRS.flatMap(sourceFiles).flatMap(findings);
    expect(all).toEqual([]);
  });

  describe("the check itself", () => {
    const check = (src: string) => {
      const file = path.join(ROOT, "app", "__probe__.tsx");
      const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const upper = uppercaseStyleKeys(sf);
      const hits: string[] = [];
      const visit = (node: ts.Node): void => {
        const open = ts.isJsxElement(node)
          ? node.openingElement
          : ts.isJsxSelfClosingElement(node)
            ? node
            : undefined;
        if (open && open.tagName.getText() === "Text") {
          const style = attr(open, "style");
          const used = style?.initializer ? referencedStyleNames(style.initializer) : [];
          if (
            used.some((n) => upper.has(n)) &&
            !attr(open, "accessibilityLabel") &&
            !coveredByAncestor(open)
          ) {
            hits.push("hit");
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
      return hits.length;
    };

    const SHEET = 'const styles = StyleSheet.create({ cap: { textTransform: "uppercase" }, plain: {} });';

    it("catches the shape that shipped in twelve places", () => {
      expect(check(`${SHEET} const A = () => <Text style={styles.cap}>On hold</Text>;`)).toBe(1);
    });

    it("passes once the label is stated, which is the #981 fix", () => {
      expect(
        check(`${SHEET} const A = () => <Text accessibilityLabel={l} style={styles.cap}>{l}</Text>;`),
      ).toBe(0);
    });

    it("sees the style inside an array, which is how every active/inactive pair is written", () => {
      expect(
        check(`${SHEET} const A = () => <Text style={[styles.cap, on && styles.plain]}>x</Text>;`),
      ).toBe(1);
    });

    it("ignores Text that is not uppercased", () => {
      expect(check(`${SHEET} const A = () => <Text style={styles.plain}>x</Text>;`)).toBe(0);
    });

    it("resolves the style KEY, not the file — an uppercase style elsewhere does not taint a sibling", () => {
      // `cap` is uppercase and `plain` is not; only the Text using `cap` may be reported.
      expect(
        check(`${SHEET} const A = () => <><Text style={styles.plain}>a</Text><Text style={styles.cap}>b</Text></>;`),
      ).toBe(1);
    });

    it("exempts a fragment inside a labelled accessibility group", () => {
      // The parent speaks once for the whole subtree; the child's string is never reached.
      expect(
        check(
          `${SHEET} const A = () => <Pressable accessible accessibilityLabel="Acme, on hold"><Text style={styles.cap}>On hold</Text></Pressable>;`,
        ),
      ).toBe(0);
    });

    it("exempts it under a labelled Pressable with NO explicit `accessible`, which is how the cards are written", () => {
      // Pressable passes accessible={true} itself. Requiring the prop reported DealCard, LeadCard and
      // BoardCard — the three sites that already label the whole card correctly.
      expect(
        check(
          `${SHEET} const A = () => <Pressable accessibilityLabel="Acme, on hold"><Text style={styles.cap}>On hold</Text></Pressable>;`,
        ),
      ).toBe(0);
    });

    it("does NOT exempt it under a labelled plain View, which does not group", () => {
      // `accessible` is false on View unless set, so the transformed text is still its own element.
      expect(
        check(
          `${SHEET} const A = () => <View accessibilityLabel="Acme"><Text style={styles.cap}>On hold</Text></View>;`,
        ),
      ).toBe(1);
    });

    it("does NOT exempt a grouping ancestor with no label of its own", () => {
      // RN then composes the name from descendant text — which is the transformed string again, so the
      // exemption must require BOTH halves or it becomes a way through.
      expect(
        check(`${SHEET} const A = () => <Pressable><Text style={styles.cap}>On hold</Text></Pressable>;`),
      ).toBe(1);
    });

    it("exempts Text hidden from the accessibility tree", () => {
      expect(
        check(`${SHEET} const A = () => <Text accessibilityElementsHidden style={styles.cap}>x</Text>;`),
      ).toBe(0);
    });

    it("finds the transform when it sits beside a spread token", () => {
      // Every real site is `{ ...theme.type.caption, textTransform: "uppercase" }` — the token omits the
      // transform deliberately (Row.tsx:31-33), so it is always declared alongside a spread.
      expect(
        check(
          'const styles = StyleSheet.create({ cap: { ...theme.type.caption, textTransform: "uppercase", color: c } });' +
            " const A = () => <Text style={styles.cap}>x</Text>;",
        ),
      ).toBe(1);
    });
  });
});
