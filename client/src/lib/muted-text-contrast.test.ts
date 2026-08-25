import fs from "fs";
import path from "path";
import tailwindColors from "tailwindcss/colors";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// `text-slate-400` ON A LIGHT BACKGROUND IS 2.5:1. AA WANTS 4.5.
//
// Measured on production, not derived from the palette:
//
//   /reports/monday-showcase   slate-400 on slate-50 @10px    → 2.45:1
//   /projects/weekly-reports   slate-400 on white   @11.5px   → 2.56:1
//   /companies                 slate-500 on slate-100 @10px   → 4.34:1
//
// The first two are roughly half the contrast WCAG 2.2 SC 1.4.3 requires — on hint text, column captions
// and status meta, which is exactly the text somebody squints at. `slate-500` on white is 4.76:1 and
// clears it; `slate-600` is 7.58:1.
//
// A RATCHET, NOT A RULE, AND DELIBERATELY SO. There are 364 `text-slate-400` usages across 87 files and
// most are FINE: on a dark surface, slate-400 is the correct choice and moving it to slate-500 would make
// contrast WORSE. Static analysis cannot tell which is which — the background usually comes from an
// ancestor — so a blanket rewrite would be a guess dressed as a fix, and a global assertion would fail on
// ~140 sites nobody has measured.
//
// So this pins the count and fails when it GROWS. The sites fixed alongside it are the ones actually
// measured failing in the browser. The rest are a design decision — darkening muted text app-wide changes
// how the product looks — and that belongs to whoever owns the visual system, not to a sweep.
//
// LOWER THIS NUMBER, never raise it. If a change legitimately adds one on a dark surface, say so here.

const CLIENT_SRC = path.resolve(__dirname, "..");

/**
 * Tailwind text sizes in px. Arbitrary `text-[Npx]` is parsed separately.
 */
const TEXT_SIZE_PX: Record<string, number> = {
  "text-xs": 12,
  "text-sm": 14,
  "text-base": 16,
  "text-lg": 18,
  "text-xl": 20,
  "text-2xl": 24,
  "text-3xl": 30,
  "text-4xl": 36,
  "text-5xl": 48,
};

/** Weights at or above 700, which is what WCAG means by bold. `font-semibold` is 600 and does not count. */
const BOLD = /\bfont-(?:bold|extrabold|black)\b/;

/** Any stated font weight. A branch that sets one is judged on it rather than on an inherited weight. */
const WEIGHT = /\bfont-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black)\b/;

/**
 * Per-FILE counts at the time the measured failures were fixed.
 *
 * REGENERATED for the per-ATTRIBUTE scanner. Each widening of the scanner has raised this number, and
 * every rise was debt the previous version could not see rather than debt newly added: 137 when it read
 * per line, 166 once `text-sm`/`text-base` and template literals were included, 173 once composed
 * `cn(...)` arguments were read as one element's classes, 217 once an inherited size counted, and 219 once
 * classes referenced BY NAME resolved — see `moduleConstants` for why that last one mattered most. The
 * earlier note follows.
 *
 * Formerly: regenerated after the per-class-string correction below. Judging per LINE had counted 5 sites that are
 * not sites at all — a class string carrying `text-slate-400` without a small size, on a line where some
 * other element supplied one. A baseline 5 too high is 5 real regressions the ratchet would absorb in
 * silence, which is the same slack the aggregate-count version was rejected for.
 *
 * PER FILE, NOT A TOTAL, and that distinction is the whole guard. A single aggregate with a tolerance —
 * which is what this was — lets a change delete five sites in one file, add five in another, and pass
 * both assertions while shipping five new low-contrast labels. Balanced books, unchanged number, real
 * regression. Codex caught that; it is not hypothetical, it is just arithmetic.
 *
 * File paths rather than file:line, because line numbers move on every unrelated edit above them and a
 * baseline nobody can keep accurate is a baseline people delete. A count per file is tight enough that
 * hiding a new site means removing one from the SAME file.
 *
 * Each entry is `text-slate-400` on small text — a POSSIBLE failure, since whether it fails depends on the
 * background it lands on. That is why they were not swept blindly. LOWER these numbers as sites are fixed;
 * never raise one without saying why it is on a dark surface.
 */
const BASELINE: Record<string, number> = {
  "components/__harness__/list-detail-harness.tsx": 5,
  "components/__harness__/mobile-ui-harness.tsx": 1,
  "components/audit/activity-feed-entry.tsx": 1,
  "components/auth/auth-entry-screen.tsx": 3,
  "components/comms/email-list.tsx": 1,
  "components/deals/deals-list-section.tsx": 6,
  "components/deals/decorated-kanban-card.tsx": 1,
  "components/deals/pipeline-progress.tsx": 2,
  "components/director/rep-commission-drilldown.tsx": 6,
  "components/email/email-compose-dialog.tsx": 1,
  "components/layout/detail-page-shell.tsx": 1,
  "components/layout/sidebar.tsx": 1,
  "components/leads/lead-kanban-board.tsx": 1,
  "components/pipeline/pipeline-board-column.tsx": 2,
  "components/pipeline/pipeline-record-card.tsx": 3,
  "components/reports/data-mining-section.tsx": 6,
  "components/reports/forecast-variance-section.tsx": 10,
  "components/reports/regional-ownership-section.tsx": 12,
  "components/reports/source-performance-section.tsx": 4,
  "pages/admin/pipeline-config-page.tsx": 2,
  "pages/admin/users-page.tsx": 7,
  "pages/commissions/commission-evidence-drawer.tsx": 2,
  "pages/commissions/rep-commissions-page.tsx": 1,
  "pages/commissions/team-commissions-page.tsx": 3,
  "pages/companies/company-list-page.tsx": 2,
  "pages/contacts/contact-list-page.tsx": 1,
  "pages/dashboard/rep-dashboard-page.tsx": 3,
  "pages/deals/deal-billing-tab.tsx": 5,
  "pages/deals/deal-detail-page.tsx": 1,
  "pages/deals/deal-list-page.tsx": 1,
  "pages/director/director-rep-detail.tsx": 3,
  "pages/email/email-inbox-page.tsx": 1,
  "pages/files/files-page.tsx": 2,
  "pages/leads/lead-list-page.tsx": 2,
  "pages/projects/projects-page.tsx": 2,
  "pages/projects/weekly-report-history-panel.tsx": 14,
  "pages/projects/weekly-report-project-audit-dialog.tsx": 2,
  // 1 → 3 when class constants started resolving: a shared input class-string const carrying
  // `placeholder:text-slate-400`, referenced from two attributes that read as empty before.
  "pages/projects/weekly-report-project-dialog.tsx": 3,
  "pages/projects/weekly-report-send-dialog.tsx": 8,
  "pages/projects/weekly-report-settings-dialog.tsx": 2,
  "pages/projects/weekly-reports-page.tsx": 2,
  "pages/properties/property-list-page.tsx": 3,
  "pages/public/daily-summary-page.tsx": 9,
  "pages/reports/at-risk-page.tsx": 2,
  "pages/reports/canvassing-activity-page.tsx": 2,
  "pages/reports/daily-activity-log-page.tsx": 2,
  "pages/reports/field-team-page.tsx": 4,
  "pages/reports/forecast-confidence-page.tsx": 4,
  "pages/reports/monday-showcase/evidence-drawer.tsx": 1,
  "pages/reports/performance-report-ui.tsx": 1,
  "pages/reports/platform-usage-page.tsx": 5,
  "pages/reports/platform-usage-rep-detail-page.tsx": 2,
  "pages/reports/qc-reports-page.tsx": 6,
  "pages/reports/rep-pack-page.tsx": 6,
  "pages/scorecards/corrective-action-responder.tsx": 1,
  "preview-main.tsx": 1,
  "preview/commissions-preview.tsx": 1,
  "preview/comms-preview.tsx": 1,
  "preview/companies-preview.tsx": 3,
  "preview/company-detail-preview.tsx": 2,
  "preview/contacts-preview.tsx": 2,
  // 2 → 3: a tone picked by ternary into a local const, then referenced from the attribute.
  "preview/deal-detail-preview.tsx": 3,
  "preview/deals-preview.tsx": 4,
  "preview/director-dashboard-preview.tsx": 2,
  "preview/email-preview.tsx": 1,
  "preview/files-page-preview.tsx": 2,
  "preview/leads-preview.tsx": 4,
  "preview/properties-preview.tsx": 3,
  "preview/rep-dashboard-preview.tsx": 3,
  "preview/reports-preview.tsx": 2,
  "preview/tasks-preview.tsx": 2,
};

/**
 * Tailwind's palette, READ FROM THE INSTALLED PACKAGE rather than transcribed.
 *
 * It used to be a hand-written slate scale, and being slate-only was a hole with a cost: reverting an
 * audited fix to `text-gray-400` — the same ~2.5:1 against white, a different family — was silently
 * DROPPED rather than failed, and the ratchet watches only `text-slate-400`, so nothing caught it.
 * Verified by making that edit and watching 7/7 pass.
 *
 * Reading the real module also removes the transcription risk that made hand-typing 60 more RGB triples
 * unappealing in the first place. The deprecated v2 aliases (`lightBlue`, `blueGray`, …) are excluded by
 * name because merely enumerating them prints a migration warning.
 */
const COLOR_FAMILIES = [
  "slate", "gray", "zinc", "neutral", "stone", "red", "orange", "amber", "yellow", "lime", "green",
  "emerald", "teal", "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose",
];

function hexToRgb(hex: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const value = parseInt(match[1]!, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

const PALETTE: Record<string, [number, number, number]> = (() => {
  const palette: Record<string, [number, number, number]> = {
    white: [255, 255, 255],
    black: [0, 0, 0],
  };
  const colors = tailwindColors as unknown as Record<string, Record<string, string> | string>;
  for (const family of COLOR_FAMILIES) {
    const shades = colors[family];
    if (!shades || typeof shades === "string") continue;
    for (const [shade, value] of Object.entries(shades)) {
      const rgb = typeof value === "string" ? hexToRgb(value) : null;
      if (rgb) palette[`${family}-${shade}`] = rgb;
    }
  }
  return palette;
})();

/** A colour token as it appears after `bg-` or `text-`. Resolvability is checked against PALETTE. */
const COLOR_TOKEN = String.raw`[a-z]+-\d{2,3}|white|black`;

/**
 * The pages whose contrast failures were measured in a browser, each with the number of pairs the scanner
 * must still find in it.
 *
 * The floor is a CONTROL, and it is per file because a single floor on one member proves nothing about the
 * others: if a resolver regression took weekly-reports-page to zero pairs, the outcome assertion would
 * still report clean and the floor on region-report-page would still pass. Raise these as coverage grows;
 * a drop means the scanner is reading less than it used to.
 */
const AUDITED: Record<string, number> = {
  "pages/projects/weekly-reports-page.tsx": 1,
  "pages/reports/monday-showcase/variants.tsx": 1,
  "pages/reports/region-report-page.tsx": 4,
};

/**
 * The px size a class string states, or null when it states none (and therefore inherits one).
 *
 * `rem` AND `em` COUNT, not just `px`. `text-[0.76rem]` is an established convention here —
 * pipeline-board-column.tsx uses it, with a `text-slate-400` label nested inside inheriting that size —
 * and a px-only parser resolved neither the element nor its child, so both fell out of the ratchet. Both
 * units are 16px at the browser default; nothing in this app changes the root font size.
 */
function statedSizePx(classes: string): number | null {
  const arbitrary = /(?:^|\s)text-\[(\d+(?:\.\d+)?)(px|rem|em)\]/.exec(classes);
  if (arbitrary) {
    const value = Number(arbitrary[1]);
    return arbitrary[2] === "px" ? value : value * 16;
  }
  for (const [token, size] of Object.entries(TEXT_SIZE_PX)) {
    if (new RegExp(`(?:^|\\s)${token}(?![\\w-])`).test(classes)) return size;
  }
  return null;
}

/**
 * Is text at this size, with this weight, NORMAL — the case AA holds to 4.5:1 rather than 3:1?
 *
 * WCAG's "large text" is 24px, or 18.66px when bold. `font-semibold` is 600 and does NOT count; only
 * 700+ does.
 *
 * AN UNKNOWN SIZE IS SKIPPED, AND THAT IS A MEASURED HOLE, NOT A NEUTRAL DEFAULT. An element that states
 * no size and has no sized ancestor in its own file renders at the browser default of 16px, which is
 * normal text — so skipping it excludes real sites rather than undecidable ones. Counting `null` as 16px
 * instead raises **34 files by +81 sites**, plus files with no baseline entry at all.
 *
 * Left out of THIS change deliberately, and the distinction is what makes that defensible: the hole limits
 * how much FUTURE debt the ratchet covers, it does not let any site fixed here revert undetected. Both of
 * those are pinned by their own mutation-proved assertions. Widening it is a baseline regeneration across
 * a third of the tree and belongs in its own change.
 *
 * Written down because the lesson of this file is that an exclusion is a coverage hole with a
 * justification attached, and the justification does not shrink the hole. See `moduleConstants` for the
 * round where an undocumented one hid a reverted fix.
 */
function isNormalSize(px: number | null, classes: string): boolean {
  if (px === null) return false;
  return !(px >= 24 || (px >= 18.66 && BOLD.test(classes)));
}

/**
 * Strip the wrappers that sit between a declaration and its value.
 *
 * `const TONE = { … } as const` is an `AsExpression`, not an `ObjectLiteralExpression`, so a resolver that
 * type-checks for the latter treats the whole map as empty. That shape is already in use here —
 * `preview/deals-preview.tsx:77` — and adding `text-slate-400` to such a map passed every assertion.
 */
function unwrapExpression(node: ts.Node): ts.Node {
  let current = node;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

const CONSTANTS = new WeakMap<ts.SourceFile, Map<string, ts.Node>>();

/**
 * Every `const NAME = …` initializer in a file, so classes referenced BY NAME can be followed.
 *
 * A `className` does not have to contain its classes. The audited weekly-reports page routes them through
 * a lookup table, which is the ordinary way to write a variant map here:
 *
 *   const STATE_BADGE: Record<WeeklyReportWeekState, string> = { dismissed: "… bg-white text-slate-500", … }
 *   <Badge className={`${STATE_BADGE[row.state]} whitespace-nowrap`}>
 *
 * A reader that only collects literals INSIDE the attribute sees `whitespace-nowrap` and nothing else — so
 * reverting the `dismissed` entry to `text-slate-400` left both guards green, one of them the very ratchet
 * that exists to stop exactly that. Verified by making the edit and watching 6/6 pass.
 *
 * SAME FILE ONLY, and first declaration wins on a name collision. An imported map is still invisible; that
 * is a smaller hole than the one this closes, and it is stated rather than silently handled.
 */
function moduleConstants(source: ts.SourceFile): Map<string, ts.Node> {
  const cached = CONSTANTS.get(source);
  if (cached) return cached;
  const table = new Map<string, ts.Node>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (!table.has(node.name.text)) table.set(node.name.text, node.initializer);
    }
    node.forEachChild(visit);
  };
  visit(source);
  CONSTANTS.set(source, table);
  return table;
}

/**
 * The initializers a class-carrying REFERENCE can resolve to, in declaration order.
 *
 * A dynamic key (`STATE_BADGE[row.state]`) can select any entry, so every value is returned — the
 * pessimistic reading, which is the right one for "could this render low contrast". A literal key
 * (`STATE_BADGE.dismissed`) returns just that entry.
 */
function resolveReference(node: ts.Node, seen: Set<ts.Node>): ts.Node[] {
  const table = moduleConstants(node.getSourceFile());
  if (ts.isIdentifier(node)) {
    const declaration = table.get(node.text);
    return declaration && !seen.has(declaration) ? [declaration] : [];
  }
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return [];
  if (!ts.isIdentifier(node.expression)) return [];
  const bound = table.get(node.expression.text);
  const declaration = bound ? unwrapExpression(bound) : undefined;
  if (!declaration || !ts.isObjectLiteralExpression(declaration) || seen.has(declaration)) return [];
  const key = ts.isPropertyAccessExpression(node)
    ? node.name.text
    : ts.isStringLiteral(node.argumentExpression)
      ? node.argumentExpression.text
      : null;
  const values: ts.Node[] = [];
  for (const property of declaration.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = ts.isIdentifier(property.name)
      ? property.name.text
      : ts.isStringLiteral(property.name)
        ? property.name.text
        : null;
    if (key !== null && name !== key) continue;
    if (!seen.has(property.initializer)) values.push(property.initializer);
  }
  return values;
}

/** Is this node a reference that `resolveReference` knows how to follow? */
function isReference(node: ts.Node): boolean {
  return ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);
}

/**
 * Every class literal a `className` expression can contribute, FLATTENED — the union across branches and
 * across a lookup table's entries.
 *
 * Union, not enumeration, and deliberately: this answers the ratchet's question ("could this element ever
 * render `text-slate-400`?"), where merging branches is the correct pessimism. `classVariants` answers the
 * different question of which classes land together, and pays a combinatorial cost for it that is not
 * worth spending on every file in the tree.
 */
function literalClasses(node: ts.Node, seen: Set<ts.Node> = new Set()): string {
  const parts: string[] = [];
  const gather = (n: ts.Node, visited: Set<ts.Node>): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) parts.push(n.text);
    else if (ts.isTemplateExpression(n)) {
      parts.push(n.head.text);
      for (const span of n.templateSpans) parts.push(span.literal.text);
    }
    if (isReference(n)) {
      for (const target of resolveReference(n, visited)) {
        const next = new Set(visited);
        next.add(target);
        gather(target, next);
      }
      return; // the reference's own children are the object name and the key, never classes
    }
    n.forEachChild((child) => gather(child, visited));
  };
  gather(node, seen);
  return parts.join(" ");
}

/**
 * Every `className` expression in a file, flattened to the classes it can apply to ONE element.
 *
 * PER ATTRIBUTE, VIA THE PARSER — which is where this should have started. Judging line by line, then
 * quoted-string by quoted-string, produced four separate findings in a row, each a different way for a
 * real site to fall between the cracks:
 *
 *   cn("min-w-0 truncate text-[10px] …",            ← the size lives in argument one
 *      isFallback ? "text-slate-400" : "text-brand-red")   ← the colour in argument two
 *
 * No individual string carries both, so a per-string scan omitted the site entirely — and it is an
 * existing convention here, not a corner case. Multi-line attributes had the same problem for the same
 * reason: the unit of styling is the ATTRIBUTE, so that is the unit to read.
 *
 * Conditional branches are UNIONED on purpose. `isFallback ? "text-slate-400" : "text-brand-red"` really
 * can render as slate-400, so the pessimistic reading is the correct one for "could this be low
 * contrast". It is also why an icon's classes no longer need a heuristic: they live in the icon's own
 * attribute and never join this one.
 */
function classNameAttributes(
  file: string,
): { classes: string; line: number; initializer: ts.Node; sizePx: number | null; weightClasses: string }[] {
  const text = fs.readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: {
    classes: string;
    line: number;
    initializer: ts.Node;
    sizePx: number | null;
    weightClasses: string;
  }[] = [];

  /** Literal classes on a JSX element's own className attribute, or "" when it has none. */
  const ownClasses = (element: ts.Node): string => {
    const opening = ts.isJsxElement(element)
      ? element.openingElement
      : ts.isJsxSelfClosingElement(element)
        ? element
        : null;
    if (!opening) return "";
    for (const property of opening.attributes.properties) {
      if (!ts.isJsxAttribute(property) || property.name.getText() !== "className") continue;
      if (!property.initializer) return "";
      return literalClasses(property.initializer);
    }
    return "";
  };

  /**
   * The size this element renders at: its own, or the nearest ancestor that states one.
   *
   * FONT SIZE INHERITS, and skipping every attribute without a size token meant a muted child of a sized
   * parent was invisible — `<h3 className="text-sm …">Contract <span className="text-slate-400">(optional)
   * </span></h3>` is 14px normal text at 2.56:1, and it is an existing convention here, not a corner case.
   * Only the SIZE is inherited; the colour is whatever the child itself sets, which is why they are
   * resolved separately.
   */
  const effectiveSize = (attribute: ts.Node): { px: number | null; weightClasses: string } => {
    let node: ts.Node | undefined = attribute.parent;
    let weightClasses = "";
    while (node) {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const classes = ownClasses(node);
        if (!weightClasses && BOLD.test(classes)) weightClasses = classes;
        const px = statedSizePx(classes);
        if (px !== null) return { px, weightClasses: weightClasses || classes };
      }
      node = node.parent;
    }
    return { px: null, weightClasses };
  };

  /**
   * The weight this element INHERITS — the nearest ancestor stating one, and nothing of its own.
   *
   * Ancestor-only on purpose. Folding the element's own classes in here defeats the whole point: a
   * conditionally-bold element flattens to a string containing `font-bold`, so the branch that renders at
   * normal weight inherits a boldness it does not have, and a 20px label gets waved through as large text.
   * Its own weight belongs to the VARIANT, which is where each branch can be seen separately.
   */
  const inheritedWeight = (attribute: ts.Node): string => {
    // Walk past the element this attribute BELONGS to first. Starting at `attribute.parent` reaches that
    // element's own opening tag, so it inherits its own classes from itself — and a conditionally-bold
    // element then looks unconditionally bold no matter how carefully the variants are enumerated. That
    // is the whole defect, one level up from where it appeared.
    let node: ts.Node | undefined = attribute.parent;
    while (node && !ts.isJsxElement(node) && !ts.isJsxSelfClosingElement(node)) node = node.parent;
    node = node?.parent;
    while (node) {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const classes = ownClasses(node);
        if (WEIGHT.test(classes)) return classes;
      }
      node = node.parent;
    }
    return "";
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && node.name.getText() === "className" && node.initializer) {
      const classes = literalClasses(node.initializer);
      if (classes.trim().length > 0) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        const own = statedSizePx(classes);
        const inherited = own === null ? effectiveSize(node) : null;
        // `classes` stays the element's OWN classes — the colour is whatever it sets, and folding an
        // ancestor's classes in here would let a parent's `text-slate-400` be attributed to a child that
        // never set it. Only the SIZE and the WEIGHT are inherited, and they travel separately.
        out.push({
          classes,
          line: line + 1,
          initializer: node.initializer!,
          sizePx: own ?? inherited?.px ?? null,
          weightClasses: inheritedWeight(node),
        });
      }
    }
    node.forEachChild(visit);
  };
  visit(source);
  return out;
}

/**
 * A ceiling on the branch combinations one attribute can expand to. Exceeding it THROWS rather than
 * truncating: a silently-shortened variant list is a pair that stops being checked, which is the same
 * class of hole this whole enumerator exists to close. The audited files top out at 4.
 */
const MAX_VARIANTS = 64;

/**
 * The distinct class strings ONE element can actually render, enumerated branch by branch.
 *
 * WHY NOT JUST SKIP CONDITIONALS, which is what this did until Codex pointed at the consequence: the
 * badge whose contrast this PR fixed is written as
 *
 *   className={`… text-[9px] ${snapshot ? "bg-slate-100 text-slate-600" : "bg-indigo-50 text-indigo-600"}`}
 *
 * so reverting it to the 4.34:1 `text-slate-500` left the guard green — the attribute was conditional, the
 * pair check discarded it whole, and the ratchet only ever watches `text-slate-400`. The guard could not
 * fire on the very element it was written for. Verified by making that edit and watching 5/5 pass.
 *
 * Enumerating instead of skipping ALSO removes the false positive the skip was introduced for. A branch is
 * evaluated against itself, so `${dark ? "bg-white/20 text-white" : …}` no longer reports white-on-white at
 * 1.0:1 — the two tokens never appear in the same variant, and `bg-white/20` is opacity-modified and
 * dropped on its own merits. Union for a ternary (one branch OR the other), product for concatenation and
 * for `cn(...)` arguments (all of them apply at once), and `""` for anything unresolvable — an identifier
 * such as `accent.grad` contributes no literal, exactly as the flattened read did.
 */
function classVariants(node: ts.Node, seen: Set<ts.Node> = new Set()): string[] {
  const recurse = (child: ts.Node): string[] => classVariants(child, seen);
  const cap = (values: string[]): string[] => {
    if (values.length > MAX_VARIANTS) {
      throw new Error(`className expands to ${values.length} branch combinations, over the ${MAX_VARIANTS} cap`);
    }
    return values;
  };
  const union = (left: string[], right: string[]): string[] => cap([...left, ...right]);
  const product = (left: string[], right: string[]): string[] =>
    cap(left.flatMap((a) => right.map((b) => `${a} ${b}`)));

  if (ts.isJsxExpression(node)) return node.expression ? recurse(node.expression) : [""];
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node)
  ) {
    return recurse(node.expression);
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isTemplateExpression(node)) {
    let acc = [node.head.text];
    for (const span of node.templateSpans) {
      acc = product(product(acc, recurse(span.expression)), [span.literal.text]);
    }
    return acc;
  }
  if (ts.isConditionalExpression(node)) {
    return union(recurse(node.whenTrue), recurse(node.whenFalse));
  }
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    // `cond && "…"` renders the classes or nothing at all — both are real states.
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return union([""], recurse(node.right));
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
      return union(recurse(node.left), recurse(node.right));
    }
    if (op === ts.SyntaxKind.PlusToken) return product(recurse(node.left), recurse(node.right));
    return [""];
  }
  // `cn(a, b, c)` / `clsx([...])` — every argument lands on the same element, so they multiply.
  if (ts.isCallExpression(node)) {
    let acc = [""];
    for (const argument of node.arguments) acc = product(acc, recurse(argument));
    return acc;
  }
  if (ts.isArrayLiteralExpression(node)) {
    let acc = [""];
    for (const element of node.elements) acc = product(acc, recurse(element));
    return acc;
  }
  // clsx's object form: `{ "text-slate-400": muted }` — each key applies independently or not at all.
  if (ts.isObjectLiteralExpression(node)) {
    let acc = [""];
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const name = property.name;
      if (ts.isStringLiteral(name) || ts.isIdentifier(name)) acc = product(acc, ["", name.text]);
    }
    return acc;
  }
  // Classes reached BY NAME. Each entry a reference can resolve to is a separate rendered state, so they
  // union — the same relationship a ternary's branches have, which is what a keyed lookup table is.
  if (isReference(node)) {
    const targets = resolveReference(node, seen);
    if (targets.length === 0) return [""];
    let acc: string[] = [];
    for (const target of targets) {
      const next = new Set(seen);
      next.add(target);
      acc = union(acc, classVariants(target, next));
    }
    return acc;
  }
  return [""];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(fg: [number, number, number], bg: [number, number, number]): number {
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * Foreground/background pairs stated together on one RENDERED element, with their measured contrast.
 *
 * Per BRANCH, via `classVariants` — a conditional attribute is expanded into the states it can render and
 * each is judged on its own. It used to be skipped whole, which left the guard unable to fire on the badge
 * it was written for; see `classVariants` for the mutation that proved it.
 *
 * ONE EXCLUSION REMAINS: tokens carrying an OPACITY modifier (`bg-white/70`) are skipped, because the
 * rendered colour depends on whatever is behind them and the pair is not decidable here.
 *
 * What survives is a pair genuinely applied to one element in one state, which is the only kind worth
 * asserting on.
 *
 * WHAT IT CANNOT SEE: gradients. `bg-gradient-to-br ${accent.grad} to-white` has no single background
 * colour, so a caption over the coloured end of one is outside this check entirely — which is exactly how
 * a slate-500 caption on `from-violet-50` (4.34:1) survived an earlier round of this PR and had to be
 * found by review instead. Resolving a gradient means knowing where the text sits within it, which is a
 * rendered-layout question, not a static one. Stated rather than silently unhandled.
 */
function statedPairs(file: string): { bg: string; fg: string; ratio: number; line: number }[] {
  const out: { bg: string; fg: string; ratio: number; line: number }[] = [];
  for (const attribute of classNameAttributes(file)) {
    for (const variant of classVariants(attribute.initializer)) {
      // The size can be stated in a branch of its own, so resolve it per variant and fall back to the
      // attribute's own-or-inherited size when this branch states none.
      const sizePx = statedSizePx(variant) ?? attribute.sizePx;
      // WEIGHT PER VARIANT TOO, and for the same reason. `cn("text-xl text-slate-400", loud && "font-bold")`
      // flattens to a string containing `font-bold`, so judging weight on the union calls a 20px element
      // large text and drops it — including the branch that renders at normal weight and does need 4.5:1.
      // A branch that states its own weight is judged on it; one that states none inherits.
      const weightClasses = WEIGHT.test(variant) ? variant : attribute.weightClasses;
      if (!isNormalSize(sizePx, weightClasses)) continue;
      const bg = new RegExp(String.raw`(?:^|\s)bg-(${COLOR_TOKEN})(?![\w/-])`).exec(variant);
      const fg = new RegExp(String.raw`(?:^|\s)text-(${COLOR_TOKEN})(?![\w/-])`).exec(variant);
      if (!bg || !fg) continue;
      const bgColor = PALETTE[bg[1]!];
      const fgColor = PALETTE[fg[1]!];
      // An UNRESOLVED colour is reported, not dropped. Dropping is how `text-gray-400` slipped past a
      // slate-only reader; a token shaped like a colour that this palette cannot price is a gap in the
      // instrument, and the assertion should say so rather than quietly shrink its own scope.
      if (!bgColor || !fgColor) {
        out.push({ bg: bg[1]!, fg: fg[1]!, ratio: Number.NaN, line: attribute.line });
        continue;
      }
      out.push({
        bg: bg[1]!,
        fg: fg[1]!,
        ratio: Math.round(contrast(fgColor, bgColor) * 100) / 100,
        line: attribute.line,
      });
    }
  }
  return out;
}

/**
 * Does this element render as NORMAL text in any state it can reach?
 *
 * Bold only decides in the 18.66–23.99px band, and bold is frequently conditional — so in that band the
 * question has to be asked of each rendered state rather than of the flattened string. Everywhere else the
 * size settles it and no expansion is needed, which keeps the cost off the ~1000-file walk.
 */
function rendersAsNormalText(attribute: {
  sizePx: number | null;
  weightClasses: string;
  initializer: ts.Node;
}): boolean {
  const px = attribute.sizePx;
  if (px === null) return false;
  if (px >= 24) return false;
  if (px < 18.66) return true;
  for (const variant of classVariants(attribute.initializer)) {
    const weight = WEIGHT.test(variant) ? variant : attribute.weightClasses;
    if (!BOLD.test(weight)) return true;
  }
  return false;
}

// Memoised across the suite. The sweep TS-parses every .tsx under client/src — roughly a thousand files —
// and four tests below need the same answer. Recomputing it per test spent that cost four times over and
// put each run against vitest's 5s default, which is close enough to the budget that a loaded CI runner
// tips it over: the guard then fails for want of a machine, not for want of contrast. A guard that reddens
// at random is one people learn to re-run rather than read.
//
// Safe to cache because the sweep is a pure function of files on disk, and nothing in this suite writes to
// them. It is per-run, not persisted, so a mutation to a source file is still picked up on the next run —
// which is what the mutation testing this guard was built with depends on.
let sweepCache: string[] | null = null;

function smallSlate400Sites(): string[] {
  if (sweepCache) return sweepCache;
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".tsx") || entry.name.includes(".test.")) continue;
      for (const attribute of classNameAttributes(full)) {
        if (!attribute.classes.includes("text-slate-400")) continue;
        if (!rendersAsNormalText(attribute)) continue;
        found.push(`${path.relative(CLIENT_SRC, full)}:${attribute.line}`);
      }
    }
  };
  walk(CLIENT_SRC);
  sweepCache = found;
  return found;
}

// The first test through pays for the whole sweep — ~3s locally on an idle machine, against vitest's 5s
// default. Memoising took the suite from four sweeps to one, but 60% of the budget is still not a margin:
// a CI runner under load tips it, and the guard then fails for want of a machine rather than for want of
// contrast. Given the choice between a fast guard that reddens at random and a slow one that means what it
// says, take the slow one — a flaky guard gets re-run rather than read, which is how a real finding gets
// waved through.
const SWEEP_TIMEOUT_MS = 30_000;

describe("muted text does not get quieter", { timeout: SWEEP_TIMEOUT_MS }, () => {
  it("finds the sites at all — an empty sweep would make the ratchet meaningless", () => {
    // The standing failure of a counting guard: the scan breaks, everything reports zero, and it reads as
    // an improvement. A floor matters as much as a ceiling.
    expect(smallSlate400Sites().length).toBeGreaterThan(50);
  });

  it("adds no small-text slate-400 to a file that already has some", () => {
    // Per-file, so a removal elsewhere cannot pay for an addition here.
    const byFile: Record<string, number> = {};
    for (const site of smallSlate400Sites()) {
      const file = site.slice(0, site.lastIndexOf(":"));
      byFile[file] = (byFile[file] ?? 0) + 1;
    }

    const grown = Object.entries(byFile)
      .filter(([file, count]) => file in BASELINE && count > BASELINE[file]!)
      .map(([file, count]) => `${file}: ${BASELINE[file]} → ${count}`);

    expect(
      grown,
      "new small-text text-slate-400. On a light background that is ~2.5:1 against a 4.5:1 requirement — " +
        "use text-slate-500 (4.76:1), or text-slate-600 on a slate-100 surface. If it genuinely sits on a " +
        "dark surface, raise the baseline for that file and say so.",
    ).toEqual([]);
  });

  it("adds no small-text slate-400 to a file that had none", () => {
    // The other half. Without this, a brand-new file could carry any number of them and every per-file
    // comparison above would simply not apply to it.
    const introduced = [
      ...new Set(
        smallSlate400Sites()
          .map((site) => site.slice(0, site.lastIndexOf(":")))
          .filter((file) => !(file in BASELINE)),
      ),
    ];
    expect(introduced, "these files are newly using small-text text-slate-400").toEqual([]);
  });

  it("leaves the audited pages CONTRAST-clean, not merely free of one token", () => {
    // THE ASSERTION CODEX'S REVIEW FORCED, and it is the difference between checking a fix and checking a
    // symptom. The first version asserted only that `text-slate-400` was gone from these files — so
    // swapping it for `text-slate-500` satisfied the guard while the badges on `bg-slate-100` were still
    // 4.34:1, under the 4.5 they need. The test would have certified them as clean. A guard that reads the
    // TOKEN instead of the OUTCOME is how a fix gets marked done while the defect is still on screen.
    //
    // This computes the actual ratio for every foreground/background pair stated together on small text in
    // the three files whose failures were measured in a browser.
    const failures: string[] = [];
    for (const file of Object.keys(AUDITED)) {
      for (const pair of statedPairs(path.join(CLIENT_SRC, file))) {
        // NaN is an unresolved colour, and it fails rather than passing. `<` alone would let it through,
        // which is the silent-drop this assertion was widened to stop.
        if (Number.isNaN(pair.ratio)) {
          failures.push(`${file}:${pair.line} text-${pair.fg} on bg-${pair.bg} → colour not in the palette`);
        } else if (pair.ratio < 4.5) {
          failures.push(`${file}:${pair.line} text-${pair.fg} on bg-${pair.bg} → ${pair.ratio}:1`);
        }
      }
    }

    expect(failures, "audited pages still carry small text below the 4.5:1 AA minimum").toEqual([]);
  });

  it("still finds pairs to judge in EVERY audited file — an empty scan would assert nothing", () => {
    // The scanner still skips opacity-modified tokens, for good reason. Skip too much and the assertion
    // above passes over a file it never actually read.
    //
    // ONE FLOOR PER FILE, not one floor for the set. A single floor on region-report-page left the other
    // two files with no control at all: weekly-reports-page could have dropped to zero pairs — which is
    // exactly what a resolver regression looks like — and the audited assertion would have gone on
    // reporting clean. A control that covers one member of a set is not a control on the set.
    const measured = Object.fromEntries(
      Object.keys(AUDITED).map((file) => [file, statedPairs(path.join(CLIENT_SRC, file)).length]),
    );

    const starved = Object.entries(AUDITED)
      .filter(([file, floor]) => (measured[file] ?? 0) < floor)
      .map(([file, floor]) => `${file}: ${measured[file]} pairs, floor ${floor}`);

    expect(starved, "an audited file stopped yielding pairs — the scanner is reading less than it did").toEqual([]);
  });

  it("judges each branch of a conditional separately, rather than against the other branch", () => {
    // The false positive that motivated the old blanket skip, kept as a test so the enumerator cannot
    // regress into it: two branches of one ternary must never be paired with each other. `bg-white/20` is
    // opacity-modified and unresolvable; `text-white` belongs to the same branch, and the `bg-slate-800`
    // of the other branch is the only real background here.
    const fixture = path.join(CLIENT_SRC, "lib/__fixtures__/conditional-classnames.tsx");
    const pairs = statedPairs(fixture);

    expect(pairs.map((pair) => `text-${pair.fg} on bg-${pair.bg} → ${pair.ratio}:1`)).toEqual([
      "text-white on bg-slate-800 → 14.63:1",
      "text-slate-500 on bg-slate-100 → 4.34:1",
      // Priced rather than skipped once the palette came from Tailwind instead of a hand-written slate
      // scale. It passes at 5.62:1 — the point is that it is now MEASURED and not silently dropped.
      "text-indigo-600 on bg-indigo-50 → 5.62:1",
    ]);
  });

  it("judges weight per branch, so a conditionally-bold element is not large text in every state", () => {
    // 20px at 4.34:1 passes as large text and fails as normal text, so the classification decides the
    // verdict. Judging weight on the flattened string called both branches bold and dropped the element
    // whole; only the branch that actually states `font-bold` may be treated as large.
    const fixture = path.join(CLIENT_SRC, "lib/__fixtures__/conditional-weight.tsx");

    expect(statedPairs(fixture).map((pair) => `text-${pair.fg} on bg-${pair.bg} → ${pair.ratio}:1`)).toEqual([
      "text-slate-500 on bg-slate-100 → 4.34:1",
    ]);
  });

  it("follows classes referenced by name out of the attribute", () => {
    // The blind spot that let the ratchet certify a reverted fix: a `className` need not contain its
    // classes. `TONE[tone]` is a dynamic key, so every entry is a state this element can render and each
    // is judged on its own.
    const fixture = path.join(CLIENT_SRC, "lib/__fixtures__/class-constant-lookup.tsx");

    expect(statedPairs(fixture).map((pair) => `text-${pair.fg} on bg-${pair.bg} → ${pair.ratio}:1`)).toEqual([
      "text-slate-500 on bg-slate-100 → 4.34:1",
      "text-white on bg-slate-900 → 17.85:1",
    ]);
  });
});
