import fs from "fs";
import path from "path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// AN ICON BUTTON THAT ANNOUNCES ITSELF AS "BUTTON".
//
// `<Button size="icon">` renders a control whose entire meaning is the glyph inside it. A sighted user reads
// the icon; a screen reader reads the accessible name, and a bare `<svg>` contributes nothing to one. So the
// control is announced as "button" — no verb, no object. In a toolbar of five, the user gets "button, button,
// button, button, button" and has to activate them to find out what they do.
//
// THIS IS NOT HYPOTHETICAL AND IT IS NOT CONFINED TO ONE SCREEN. The two that shipped on the app shell —
// present on EVERY page in the CRM — were the notification bell and SIGN OUT. The destructive one is the
// unlabelled one you cannot afford to discover by activating it.
//
// The bell has a second failure the first does not. It renders an unread-count `Badge` inside the button, so
// when the count is non-zero the accessible name computes from that text and the control announces itself as
// "5". That is worse than empty: "button" is at least honestly uninformative, while "5" reads as a real name
// and hides the fact that anything is missing. A count is a STATUS, not a name — it belongs in the label
// ("Notifications, 5 unread"), not as the whole of it.
//
// WHAT COUNTS AS A NAME HERE. `aria-label`, `aria-labelledby`, a `title`, visible text, or an `sr-only` span.
// `title` is the weakest of these — it computes a name but never appears for a touch user, who gets no
// tooltip — so it is accepted rather than endorsed; the goal of this guard is that no control has NOTHING.
//
// WHY THE TYPESCRIPT PARSER AND NOT A REGEX. The first version of this sweep scanned lines and reported 19
// offenders. Several were false: it accumulated an element's text until it saw a `>`, and the `>` in the
// `=>` of an `onClick` arrow ended the element early, so `title="Open"` sitting one line further down was
// never read. A guard that reports a control as unlabelled when it is labelled trains people to ignore it,
// which costs more than not having it. The real parser sees the real element.

const CLIENT_SRC = path.resolve(__dirname, "../..");

interface IconButton {
  file: string;
  line: number;
  snippet: string;
}

/** Attribute value as source text, or null when absent / spread-only. */
function attr(node: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | null {
  for (const property of node.attributes.properties) {
    if (ts.isJsxAttribute(property) && property.name.getText() === name) return property;
  }
  return null;
}

/**
 * Does this element carry text a screen reader would read as the control's name?
 *
 * ATTRIBUTE SUBTREES ARE SKIPPED, and that is the whole correctness of this function. The first version
 * walked with a plain `forEachChild`, which descends into the opening element and therefore into every
 * attribute — so `className="text-slate-500 hover:bg-slate-100"` matched as "text a screen reader would
 * read". Every button in the codebase looked named, all three tests went green on the first run, and the
 * sweep asserted nothing at all. A styling string is not a label; nothing inside an attribute is.
 *
 * An `sr-only` span needs no special case once this is right: it is a child element with real JSX text
 * inside it, so the ordinary text walk finds it.
 */
function hasAccessibleText(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    // The line this function turns on.
    if (ts.isJsxAttribute(child)) return;
    // Real prose between the tags. `{" "}` and whitespace do not name anything.
    if (ts.isJsxText(child) && /[A-Za-z]{2,}/.test(child.getText())) found = true;
    // A string rendered as a child — `{"Close"}`, or a `{label ?? "Open"}` fallback.
    if (
      (ts.isStringLiteral(child) || ts.isNoSubstitutionTemplateLiteral(child)) &&
      /[A-Za-z]{2,}/.test(child.text)
    ) {
      found = true;
    }
    child.forEachChild(visit);
  };
  node.forEachChild(visit);
  return found;
}

/** Every `<Button size="icon">` in the client, paired with whether it names itself. */
function iconButtons(): { named: IconButton[]; unnamed: IconButton[] } {
  const named: IconButton[] = [];
  const unnamed: IconButton[] = [];

  const walkDir = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "__harness__") continue;
        walkDir(full);
      } else if (entry.name.endsWith(".tsx")) {
        collect(full);
      }
    }
  };

  const collect = (file: string): void => {
    const text = fs.readFileSync(file, "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

    const visit = (node: ts.Node): void => {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const opening = ts.isJsxElement(node) ? node.openingElement : node;
        const tag = opening.tagName.getText();
        const size = attr(opening, "size");
        const isIconSized =
          size?.initializer !== undefined &&
          ts.isStringLiteral(size.initializer) &&
          size.initializer.text === "icon";

        if (tag === "Button" && isIconSized) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart());
          const entry: IconButton = {
            file: path.relative(CLIENT_SRC, file),
            line: line + 1,
            snippet: text.slice(node.getStart(), node.getStart() + 60).replace(/\s+/g, " "),
          };
          const labelled =
            attr(opening, "aria-label") !== null ||
            attr(opening, "aria-labelledby") !== null ||
            attr(opening, "title") !== null ||
            hasAccessibleText(node);
          (labelled ? named : unnamed).push(entry);
        }
      }
      node.forEachChild(visit);
    };
    visit(source);
  };

  walkDir(CLIENT_SRC);
  return { named, unnamed };
}

describe("an icon button says what it does", () => {
  it("finds icon buttons at all — an empty sweep passes everything below vacuously", () => {
    // The standing failure mode of a source-scanning guard: a renamed component or a moved directory empties
    // the list, and every assertion over nothing is green. This codebase has shipped that shape before.
    const { named, unnamed } = iconButtons();
    expect(named.length + unnamed.length).toBeGreaterThan(20);
  });

  it("still parses labels it should accept, so the sweep is not reporting everything", () => {
    // The mirror of the check above. A parser that fails to read ANY attribute would report every button as
    // unnamed, and the real assertion would look meaningful while testing that the parser is broken.
    const { named } = iconButtons();
    expect(named.length).toBeGreaterThan(0);
  });

  it("leaves no icon button announcing itself as just 'button'", () => {
    const { unnamed } = iconButtons();
    expect(
      unnamed.map((b) => `${b.file}:${b.line}  ${b.snippet}`),
      "these controls are an icon and nothing else — a screen reader announces them as 'button'",
    ).toEqual([]);
  });
});
