import fs from "fs";
import path from "path";
import * as ts from "typescript";

/**
 * A control that is disabled must SAY it is disabled.
 *
 * `disabled` stops the press. It does not change what VoiceOver announces: without
 * `accessibilityState={{ disabled: true }}` the control is still read as an ordinary available button,
 * and the only remaining signal is `opacity: 0.5` — which is not a signal at all to someone who cannot
 * see it. The rep taps, nothing happens, and nothing explains why.
 *
 * This is drift, not oversight: 13 controls in this app already pair the two correctly, so the pattern
 * was known. What it lacked was anything that noticed the pairing had been dropped. The clearest case
 * was `formStyles.button`, used identically by `login.tsx` and `change-password.tsx` — login announced
 * `{ disabled, busy }`, change-password announced nothing, on the SAME shared control. `formStyles.ts`
 * exists because those two screens "were duplicated and had already drifted"; extracting the styles did
 * not stop them drifting again on the half nobody could see.
 *
 * WHAT IT FLAGS: a JSX element with a `disabled` prop and no `accessibilityState` carrying a `disabled`
 * key.
 *
 * WHAT IT ALLOWS: an `accessibilityState` that is a spread or a variable — the value cannot be resolved
 * syntactically, and assuming the worst there would make the guard unfixable rather than informative.
 * `disabled={false}` is NOT exempt: it is a state that changes, and the announcement has to track it.
 *
 * KNOWN LIMIT: single-file and syntactic. A wrapper that takes `disabled` and forwards it to a Pressable
 * it renders elsewhere is judged where the Pressable is written, which is the right place; but a
 * component that accepts `disabled` and silently drops it is not caught by anything here.
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

function attr(el: ts.JsxOpeningElement | ts.JsxSelfClosingElement, name: string): ts.JsxAttribute | undefined {
  for (const a of el.attributes.properties) {
    if (!ts.isJsxAttribute(a)) continue;
    const n = ts.isIdentifier(a.name) ? a.name.text : a.name.getText();
    if (n === name) return a;
  }
  return undefined;
}

/**
 * Does this `accessibilityState` announce a disabled key?
 *
 * An object literal is read directly. Anything else — a spread, a variable, a call — is accepted,
 * because a syntactic walk cannot see inside it and a guard that fails on what it cannot read teaches
 * people to work around it.
 */
function announcesDisabled(a: ts.JsxAttribute): boolean {
  const init = a.initializer;
  if (!init || !ts.isJsxExpression(init) || !init.expression) return false;
  const expr = init.expression;
  if (!ts.isObjectLiteralExpression(expr)) return true;
  return expr.properties.some((p) => {
    if (ts.isSpreadAssignment(p)) return true;
    const n = p.name;
    if (!n) return false;
    return (ts.isIdentifier(n) ? n.text : n.getText()) === "disabled";
  });
}

/**
 * `disabled` on a TextInput is not the same prop.
 *
 * RN's TextInput uses `editable`, and a custom component may take `disabled` to mean something purely
 * visual. Restricting to the pressable family keeps this about controls a screen reader will offer as
 * actionable — and every real finding in this app is on one of them.
 */
const PRESSABLE_TAGS = new Set([
  "Pressable",
  "TouchableOpacity",
  "TouchableHighlight",
  "TouchableWithoutFeedback",
  "Button",
]);

function findings(file: string): string[] {
  const text = fs.readFileSync(file, "utf8");
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const syntactic = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (syntactic.length > 0) {
    return [`${path.relative(ROOT, file)}: could not be parsed (${syntactic.length} syntax errors)`];
  }

  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    const open = ts.isJsxElement(node)
      ? node.openingElement
      : ts.isJsxSelfClosingElement(node)
        ? node
        : undefined;
    if (open && PRESSABLE_TAGS.has(open.tagName.getText()) && attr(open, "disabled")) {
      const state = attr(open, "accessibilityState");
      if (!state || !announcesDisabled(state)) {
        const { line } = sf.getLineAndCharacterOfPosition(open.getStart(sf));
        hits.push(`${path.relative(ROOT, file)}:${line + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

describe("disabled controls announce that they are disabled", () => {
  it("scans a non-trivial number of files, so a broken walker cannot pass as clean", () => {
    expect(SCAN_DIRS.flatMap(sourceFiles).length).toBeGreaterThan(20);
  });

  it("finds no disabled control with a silent accessibility state", () => {
    const all = SCAN_DIRS.flatMap(sourceFiles).flatMap(findings);
    expect(all).toEqual([]);
  });

  describe("the check itself", () => {
    const check = (src: string) => {
      const file = path.join(ROOT, "app", "__probe__.tsx");
      const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const hits: string[] = [];
      const visit = (node: ts.Node): void => {
        const open = ts.isJsxElement(node)
          ? node.openingElement
          : ts.isJsxSelfClosingElement(node)
            ? node
            : undefined;
        if (open && PRESSABLE_TAGS.has(open.tagName.getText()) && attr(open, "disabled")) {
          const state = attr(open, "accessibilityState");
          if (!state || !announcesDisabled(state)) hits.push("hit");
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
      return hits.length;
    };

    it("catches the shape that shipped in seventeen places", () => {
      expect(check("const A = () => <Pressable disabled={busy} onPress={go} />;")).toBe(1);
    });

    it("catches a state object that announces something ELSE and omits disabled", () => {
      // deals/[id].tsx's watch button: the object existed and said `{ selected }`, so it looked handled.
      expect(
        check("const A = () => <Pressable disabled={p} accessibilityState={{ selected: on }} />;"),
      ).toBe(1);
    });

    it("passes the correct pairing", () => {
      expect(
        check("const A = () => <Pressable disabled={!ok} accessibilityState={{ disabled: !ok }} />;"),
      ).toBe(0);
    });

    it("accepts a coerced or renamed value, which is semantically the same announcement", () => {
      // RetryBlock writes `disabled={retrying}` against `disabled: Boolean(retrying)`. Same meaning.
      expect(
        check(
          "const A = () => <Pressable disabled={r} accessibilityState={{ disabled: Boolean(r), busy: r }} />;",
        ),
      ).toBe(0);
    });

    it("accepts a state it cannot read, rather than failing on it", () => {
      expect(check("const A = () => <Pressable disabled={x} accessibilityState={s} />;")).toBe(0);
      expect(check("const A = () => <Pressable disabled={x} accessibilityState={{ ...s }} />;")).toBe(0);
    });

    it("ignores elements that are not pressable controls", () => {
      // TextInput uses `editable`; a `disabled` prop there means something else.
      expect(check("const A = () => <TextInput disabled={x} />;")).toBe(0);
      expect(check("const A = () => <MyChip disabled={x} />;")).toBe(0);
    });

    it("does not exempt a control that is currently enabled", () => {
      // `disabled={false}` still changes at runtime; the announcement has to track it.
      expect(check("const A = () => <Pressable disabled={false} />;")).toBe(1);
    });
  });
});
