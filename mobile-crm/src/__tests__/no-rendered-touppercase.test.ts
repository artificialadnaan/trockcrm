import fs from "fs";
import path from "path";
import * as ts from "typescript";

/**
 * Tree-wide guard: never uppercase rendered text with a string operation.
 *
 * VoiceOver reads a short all-caps string as an initialism — "WON" becomes "W-O-N", a stage tab reads
 * letter by letter, and the board's scope segments ("MINE", "ALL") stop being words.
 *
 * TEXTTRANSFORM ALONE DOES NOT FIX THIS ON iOS, which is worth stating plainly because the obvious
 * belief is that it does. In the bundled RN 0.81.5,
 * `RCTAttributedTextUtils.mm` applies `RCTNSStringFromStringApplyingTextTransform` to the fragment
 * BEFORE building the attributed string, and `RCTParagraphComponentView.accessibilityLabel` returns
 * `self.attributedText.string` whenever no explicit label is set. The transformed text is therefore
 * exactly what gets spoken. Correct output needs BOTH:
 *
 *   - `textTransform: "uppercase"` in the style, so the glyphs are drawn in caps; and
 *   - an explicit mixed-case `accessibilityLabel`, which takes priority over that fallback.
 *
 * So why ban the string call at all, if a label is required either way? Because `.toUpperCase()`
 * destroys the mixed-case original AT THE SOURCE — there is then nothing left to label with, and the
 * accessible name cannot be recovered downstream. Keeping the string intact is what makes the label
 * possible; this guard protects that, not the visual result.
 *
 * Three sites shipped in #976 before this existed — the scope segments, the stage tabs, and the column
 * summary — and all three passed review and a green build, because nothing about them looks wrong in a
 * diff. That is what this file is for.
 *
 * WHAT IT FLAGS: `.toUpperCase()` / `.toLocaleUpperCase()` whose result is rendered — a child-position
 * JSX expression, or a non-handler attribute such as `accessibilityLabel`.
 *
 * WHAT IT DELIBERATELY ALLOWS, because none of it is spoken:
 *   - normalisation and comparison — `method.toUpperCase()` when building a request header;
 *   - title-casing helpers — `s.charAt(0).toUpperCase() + s.slice(1)`, which yields "Site visit", a
 *     different operation that happens to share a method name;
 *   - event handlers — `onPress={() => SAFE.has(m.toUpperCase())}`, whose value is never displayed.
 * These are separated STRUCTURALLY, by where the value goes, rather than by a list of blessed files.
 *
 * WHY IT PARSES INSTEAD OF GREPPING. `grep toUpperCase` cannot tell a header from a label, and its
 * failure mode runs the wrong way: a guard that cannot classify acquires an allowlist, and an allowlist
 * entry is permanent. A file that fails to parse is a FAILURE rather than a skip — silently dropping
 * unparseable input is fail-open, which is how a sibling guard was disarmed by a misplaced comment
 * (#958).
 *
 * KNOWN LIMIT: a value that leaves a callback WITHOUT passing a comparison is assumed to be able to
 * reach the screen, so `<Text>{xs.filter((i) => SAFE.has(i.c.toUpperCase())).length}</Text>` would be
 * flagged although only a count is drawn. That direction is deliberate — a false positive is visible
 * and fixable in one line, a false negative ships an unreadable label.
 *
 * KNOWN LIMIT: single-file and syntactic. A helper that uppercases and is rendered elsewhere is not
 * caught, and neither is a missing `accessibilityLabel` — that is a judgement this cannot make. Green
 * means "no direct route", not a proof.
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
 * True when the call's result reaches a screen reader.
 *
 * The first version stopped at a *function boundary* to exempt event handlers, which was wrong twice
 * over. It only recognised declarations, so `onPress={() => SAFE.has(m.toUpperCase())}` — an arrow, the
 * form every handler here actually uses — was still reported. And had it stopped at arrows, it would
 * have gone blind to `{items.map((i) => <Text>{i.name.toUpperCase()}</Text>)}`, which is how most
 * rendered text in this app is produced. A boundary cannot separate these: the arrow is inside JSX in
 * both, and what differs is where its VALUE goes.
 *
 * So walk outward and let the nearest JSX context decide:
 *   - a child-position expression (`<Text>{...}</Text>`) is rendered;
 *   - an attribute counts only if it is TEXT-BEARING (`accessibilityLabel`, `title`, `placeholder`);
 *     `testID`, `key`, `style` and handlers are not perceived by anyone and are exempt.
 * The map case resolves against the inner `<Text>` it returns, which is the correct answer.
 */
/**
 * Attributes whose value a person actually reads or hears.
 *
 * An ALLOWLIST, not "everything except on*". Exempting only handlers still classified `testID`, `key`,
 * `style` and every custom data prop as spoken, so an ordinary
 * `<View testID={id.toUpperCase()} />` would have failed a tree-wide test for something no user ever
 * perceives. Naming the spoken props keeps the guard about accessibility rather than about strings.
 */
const TEXT_BEARING_PROPS = new Set([
  "accessibilityLabel",
  "accessibilityHint",
  "accessibilityValue",
  "aria-label",
  "alt",
  "label",
  "title",
  "placeholder",
  "value",
  "defaultValue",
  // `<Text children={label.toUpperCase()} />` displays and announces exactly like the child-position
  // form this bans, so omitting it left an ordinary equivalent syntax as a way straight through.
  "children",
]);

/**
 * Props that are definitively NOT perceived, whatever component they are on.
 *
 * Used for CUSTOM components, where the allowlist above cannot work: this app's own text props are
 * named for their meaning (`RetryNotice.message`, `RetryBlock.body`, `ScreenHeader.context`), each
 * renders into a `<Text>` — `message` also becomes an accessibilityLabel — and a list of them would
 * need editing every time a component gains one. Silence would then be indistinguishable from safety.
 *
 * So the assumption inverts by element kind: for a custom component an unknown prop is treated as
 * rendered, and only these known-inert ones are exempt. Drift now costs a visible false positive
 * instead of an invisible miss.
 */
const NEVER_RENDERED_PROPS = new Set([
  "testID",
  "key",
  "ref",
  "style",
  "source",
  "accessibilityRole",
  "accessibilityState",
  "accessibilityHint",
  "keyboardType",
  "autoCapitalize",
  "placeholderTextColor",
  "id",
  "name",
  "type",
]);

/** JSX convention: lowercase is a host element, Capitalised is a component this repo controls. */
function isCustomComponent(attr: ts.JsxAttribute): boolean {
  const opening = attr.parent.parent;
  if (!ts.isJsxOpeningElement(opening) && !ts.isJsxSelfClosingElement(opening)) return false;
  const tag = opening.tagName.getText();
  const first = tag.split(".")[0] ?? "";
  return /^[A-Z]/.test(first) && !RN_TEXT_HOSTS.has(tag);
}

/** Built-ins whose prop surface the allowlist above already describes precisely. */
const RN_TEXT_HOSTS = new Set(["Text", "TextInput", "View", "Pressable", "Image", "ScrollView"]);

/** Operators that consume a string and yield a verdict — past one of these, nothing is displayed. */
function isPredicateBoundary(node: ts.Node): boolean {
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) return true;
  if (!ts.isBinaryExpression(node)) return false;
  switch (node.operatorToken.kind) {
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken:
    case ts.SyntaxKind.LessThanToken:
    case ts.SyntaxKind.GreaterThanToken:
    case ts.SyntaxKind.LessThanEqualsToken:
    case ts.SyntaxKind.GreaterThanEqualsToken:
      return true;
    default:
      return false;
  }
}

function isRenderedText(node: ts.Node): boolean {
  // Whether the value has been consumed by a comparison on the way out. A callback that COMPARES the
  // uppercase string returns a verdict; one that merely builds with it returns the string itself.
  let consumedByPredicate = false;

  for (let cur = node.parent; cur; cur = cur.parent) {
    if (isPredicateBoundary(cur)) consumedByPredicate = true;

    /**
     * A callback stops the walk only when its value is a VERDICT.
     *
     * `xs.find((i) => i.code.toUpperCase() === k)` renders `?.name`; the uppercase feeds the
     * comparison and never reaches the screen. But `xs.map((i) => i.n.toUpperCase()).join(", ")`
     * inside a Text renders exactly those uppercase strings — an unconditional stop here missed it,
     * because the walk meets the map callback before the outer JSX expression.
     *
     * So: past a comparison, the callback yields a boolean and nothing is displayed. Otherwise the
     * value flows out through the callback's return and the walk continues to whatever consumes it —
     * which is also why `onPress={() => SAFE.has(m.toUpperCase())}` still comes out false: it walks on
     * and meets the `on*` attribute.
     */
    if (
      (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) &&
      cur.parent &&
      ts.isCallExpression(cur.parent)
    ) {
      if (consumedByPredicate) return false;
    }

    if (ts.isJsxAttribute(cur)) {
      const name = ts.isIdentifier(cur.name) ? cur.name.text : cur.name.getText();
      if (consumedByPredicate) return false;
      // Handlers are never displayed, on any element.
      if (/^on[A-Z]/.test(name)) return false;
      // Custom component: assume rendered unless the prop is known inert. See NEVER_RENDERED_PROPS.
      if (isCustomComponent(cur)) return !NEVER_RENDERED_PROPS.has(name);
      return TEXT_BEARING_PROPS.has(name);
    }
    if (ts.isJsxExpression(cur)) {
      const parent = cur.parent;
      if (parent && (ts.isJsxElement(parent) || ts.isJsxFragment(parent))) {
        return !consumedByPredicate;
      }
    }
  }
  return false;
}

/** Both spellings mutate the accessible string identically. */
const UPPERCASE_METHODS = new Set(["toUpperCase", "toLocaleUpperCase"]);

function findings(file: string): string[] {
  const text = fs.readFileSync(file, "utf8");
  // ScriptKind by EXTENSION. Parsing a .ts file as TSX makes valid TypeScript-only angle-bracket
  // syntax — `const x = <Foo>value`, a generic arrow — read as unclosed JSX, and since diagnostics
  // deliberately fail this guard, one ordinary .ts addition would break the suite for no reason.
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
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
      UPPERCASE_METHODS.has(node.expression.name.text) &&
      isRenderedText(node)
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
          UPPERCASE_METHODS.has(node.expression.name.text) &&
          isRenderedText(node)
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

    it("catches the locale-aware spelling, which mutates the string identically", () => {
      expect(check("const A = () => <Text>{s.name.toLocaleUpperCase()}</Text>;")).toBe(1);
    });

    it("allows an INLINE arrow handler — the form every handler here actually uses", () => {
      // The first walker only treated declarations as boundaries, so this ordinary onPress was
      // reported as rendered text.
      expect(check("const A = () => <Pressable onPress={() => SAFE.has(m.toUpperCase())} />;")).toBe(0);
    });

    it("still catches uppercase inside a .map that RETURNS JSX", () => {
      // The mirror risk: exempting arrows outright would blind the guard to how most rendered text in
      // this app is produced.
      expect(
        check("const A = () => <View>{xs.map((i) => <Text>{i.name.toUpperCase()}</Text>)}</View>;"),
      ).toBe(1);
    });

    it("allows uppercase in props nobody perceives", () => {
      // testID, key and friends are not spoken and not drawn. Flagging them would make a tree-wide
      // accessibility invariant block changes that have nothing to do with accessibility.
      expect(check("const A = () => <View testID={id.toUpperCase()} />;")).toBe(0);
      expect(check("const A = () => <View key={code.toUpperCase()} />;")).toBe(0);
    });

    it("allows normalisation inside a predicate callback during render", () => {
      // The displayed value here is `name`, mixed-case. The uppercase only feeds the comparison.
      expect(
        check("const A = () => <Text>{xs.find((i) => i.code.toUpperCase() === k)?.name}</Text>;"),
      ).toBe(0);
    });

    it("still catches uppercase in the JSX a callback RETURNS", () => {
      // Guards the ordering the rule above depends on: inner JSX must decide before the callback does.
      expect(
        check("const A = () => <View>{xs.map((i) => <Text>{i.n.toUpperCase()}</Text>)}</View>;"),
      ).toBe(1);
    });

    it("catches the children PROP, which renders exactly like a child", () => {
      expect(check("const A = () => <Text children={label.toUpperCase()} />;")).toBe(1);
    });

    it("catches a callback whose RETURN VALUE becomes the rendered text", () => {
      // The case an unconditional callback-stop missed: these uppercase strings are exactly what the
      // Text displays, and the walk meets the map callback before the outer expression.
      expect(
        check('const A = () => <Text>{xs.map((i) => i.n.toUpperCase()).join(", ")}</Text>;'),
      ).toBe(1);
    });

    it("still allows the comparison form, which returns a verdict not a string", () => {
      // The pair matters: the rule is "past a comparison nothing is displayed", so both directions have
      // to hold or it is just a differently-shaped guess.
      expect(
        check("const A = () => <Text>{xs.filter((i) => i.c.toUpperCase() !== k).length}</Text>;"),
      ).toBe(0);
    });

    it("catches a custom component's text prop, which no allowlist could keep up with", () => {
      // RetryNotice.message renders as a <Text> AND becomes its accessibilityLabel; RetryBlock.body and
      // ScreenHeader.context are the same shape. Naming them would need editing per new component.
      expect(check("const A = () => <RetryNotice message={msg.toUpperCase()} />;")).toBe(1);
      expect(check("const A = () => <ScreenHeader context={office.toUpperCase()} />;")).toBe(1);
    });

    it("still exempts inert props on a custom component", () => {
      expect(check("const A = () => <RetryNotice testID={id.toUpperCase()} />;")).toBe(0);
      expect(check("const A = () => <BoardCard onPress={() => go(k.toUpperCase())} />;")).toBe(0);
    });

    it("is not fooled by the identifier appearing in a comment", () => {
      expect(check("const A = () => <Text>{/* toUpperCase() is banned here */ s.label}</Text>;")).toBe(0);
    });
  });
});
