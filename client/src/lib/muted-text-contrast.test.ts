import fs from "fs";
import path from "path";
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

/**
 * Does this class string set NORMAL-size text — the case AA holds to 4.5:1 rather than 3:1?
 *
 * WCAG's "large text" is 24px, or 18.66px when bold. Everything below that is normal, and the first
 * version of this only looked at `text-xs` and `text-[9–12px]` — so `text-sm text-slate-400` on white,
 * which fails at exactly the same 2.56:1, was invisible to the guard. `text-sm` is the most common size in
 * this codebase; excluding it left the ratchet policing the minority of cases.
 *
 * A string with no explicit size is skipped: the size is inherited and this cannot know it.
 */
function isNormalSizeText(classes: string): boolean {
  let px: number | null = null;
  const arbitrary = /(?:^|\s)text-\[(\d+(?:\.\d+)?)px\]/.exec(classes);
  if (arbitrary) px = Number(arbitrary[1]);
  else {
    for (const [token, size] of Object.entries(TEXT_SIZE_PX)) {
      if (new RegExp(`(?:^|\\s)${token}(?![\\w-])`).test(classes)) {
        px = size;
        break;
      }
    }
  }
  if (px === null) return false;
  const large = px >= 24 || (px >= 18.66 && BOLD.test(classes));
  return !large;
}

// NO ICON HEURISTIC ANY MORE, and its absence is the point. Reading per LINE meant an icon's `h-3 w-3`
// sat beside a label's classes and had to be guessed apart — badly, as it turned out, since excluding the
// whole line discarded the label too. Scoped to the ATTRIBUTE, an icon's classes are simply not in the
// label's attribute, so the distinction is structural rather than a regex someone has to maintain. Icons
// fall under SC 1.4.11 at 3:1 and remain out of scope: one with no text-size class is skipped by
// `isNormalSizeText` on its own merits.

/**
 * Per-FILE counts at the time the measured failures were fixed.
 *
 * REGENERATED for the per-ATTRIBUTE scanner. Each widening of the scanner has raised this number, and
 * every rise was debt the previous version could not see rather than debt newly added: 137 when it read
 * per line, 166 once `text-sm`/`text-base` and template literals were included, 173 once composed
 * `cn(...)` arguments were read as one element's classes. The earlier note follows.
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
  "components/auth/auth-entry-screen.tsx": 3,
  "components/deals/deals-list-section.tsx": 3,
  "components/deals/decorated-kanban-card.tsx": 1,
  "components/deals/pipeline-progress.tsx": 2,
  "components/director/rep-commission-drilldown.tsx": 6,
  "components/email/email-compose-dialog.tsx": 1,
  "components/layout/detail-page-shell.tsx": 1,
  "components/layout/sidebar.tsx": 1,
  "components/leads/lead-kanban-board.tsx": 1,
  "components/pipeline/pipeline-board-column.tsx": 1,
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
  "pages/deals/deal-billing-tab.tsx": 3,
  "pages/deals/deal-detail-page.tsx": 1,
  "pages/director/director-rep-detail.tsx": 3,
  "pages/files/files-page.tsx": 1,
  "pages/leads/lead-list-page.tsx": 1,
  "pages/projects/projects-page.tsx": 1,
  "pages/projects/weekly-report-history-panel.tsx": 10,
  "pages/projects/weekly-report-project-dialog.tsx": 1,
  "pages/projects/weekly-report-send-dialog.tsx": 7,
  "pages/projects/weekly-report-settings-dialog.tsx": 1,
  "pages/properties/property-list-page.tsx": 3,
  "pages/public/daily-summary-page.tsx": 9,
  "pages/reports/at-risk-page.tsx": 2,
  "pages/reports/daily-activity-log-page.tsx": 1,
  "pages/reports/field-team-page.tsx": 2,
  "pages/reports/forecast-confidence-page.tsx": 4,
  "pages/reports/monday-showcase/evidence-drawer.tsx": 1,
  "pages/reports/performance-report-ui.tsx": 1,
  "pages/reports/platform-usage-page.tsx": 5,
  "pages/reports/platform-usage-rep-detail-page.tsx": 2,
  "pages/reports/qc-reports-page.tsx": 5,
  "pages/reports/rep-pack-page.tsx": 6,
  "pages/scorecards/corrective-action-responder.tsx": 1,
  "preview-main.tsx": 1,
  "preview/commissions-preview.tsx": 1,
  "preview/companies-preview.tsx": 1,
  "preview/company-detail-preview.tsx": 2,
  "preview/contacts-preview.tsx": 1,
  "preview/deal-detail-preview.tsx": 2,
  "preview/deals-preview.tsx": 2,
  "preview/director-dashboard-preview.tsx": 2,
  "preview/files-page-preview.tsx": 1,
  "preview/leads-preview.tsx": 2,
  "preview/properties-preview.tsx": 1,
  "preview/rep-dashboard-preview.tsx": 3,
  "preview/tasks-preview.tsx": 1,
};


/** Tailwind slate scale + white, as RGB. Only the tokens this codebase actually pairs. */
const PALETTE: Record<string, [number, number, number]> = {
  white: [255, 255, 255],
  "slate-50": [248, 250, 252],
  "slate-100": [241, 245, 249],
  "slate-200": [226, 232, 240],
  "slate-300": [203, 213, 225],
  "slate-400": [148, 163, 184],
  "slate-500": [100, 116, 139],
  "slate-600": [71, 85, 105],
  "slate-700": [51, 65, 85],
  "slate-800": [30, 41, 59],
  "slate-900": [15, 23, 42],
  "slate-950": [2, 6, 23],
};

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
function classNameAttributes(file: string): { classes: string; line: number; conditional: boolean }[] {
  const text = fs.readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: { classes: string; line: number; conditional: boolean }[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && node.name.getText() === "className" && node.initializer) {
      const parts: string[] = [];
      const gather = (n: ts.Node): void => {
        if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) parts.push(n.text);
        else if (ts.isTemplateExpression(n)) {
          parts.push(n.head.text);
          for (const span of n.templateSpans) parts.push(span.literal.text);
        }
        n.forEachChild(gather);
      };
      gather(node.initializer);
      if (parts.length > 0) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        let conditional = false;
        const seek = (n: ts.Node): void => {
          if (ts.isConditionalExpression(n) || ts.isBinaryExpression(n)) conditional = true;
          n.forEachChild(seek);
        };
        seek(node.initializer!);
        out.push({ classes: parts.join(" "), line: line + 1, conditional });
      }
    }
    node.forEachChild(visit);
  };
  visit(source);
  return out;
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
 * Foreground/background pairs stated together in one class string, with their measured contrast.
 *
 * TWO EXCLUSIONS, both learned from false positives this scanner produced on its first run:
 *   * class strings containing a TERNARY are skipped. `${dark ? "bg-white/20 text-white" : "…"}` yielded a
 *     "text-white on bg-white at 1.0:1" report seven times over — the tokens are real but they belong to
 *     opposite branches, and nothing static can attribute them.
 *   * tokens carrying an OPACITY modifier (`bg-white/70`) are skipped. The rendered colour depends on
 *     whatever is behind it, so the pair is not decidable here.
 *
 * What survives is a pair genuinely applied to one element, which is the only kind worth asserting on.
 */
function statedPairs(file: string): { bg: string; fg: string; ratio: number; line: number }[] {
  const out: { bg: string; fg: string; ratio: number; line: number }[] = [];
  for (const attribute of classNameAttributes(file)) {
    // A CONDITIONAL ATTRIBUTE IS NOT A STATED PAIR. Unioning branches is right for "could this render low
    // contrast" (the ratchet's question) and wrong for "these two are applied together" (this one's) —
    // `${dark ? "bg-white/20 text-white" : …}` reported white-on-white at 1.0:1 seven times when this
    // scanner conflated the two questions.
    if (attribute.conditional) continue;
    if (!isNormalSizeText(attribute.classes)) continue;
    const bg = /(?:^|\s)bg-(slate-\d{2,3}|white)(?![\w/-])/.exec(attribute.classes);
    const fg = /(?:^|\s)text-(slate-\d{2,3}|white)(?![\w/-])/.exec(attribute.classes);
    if (!bg || !fg) continue;
    const bgColor = PALETTE[bg[1]!];
    const fgColor = PALETTE[fg[1]!];
    if (!bgColor || !fgColor) continue;
    out.push({
      bg: bg[1]!,
      fg: fg[1]!,
      ratio: Math.round(contrast(fgColor, bgColor) * 100) / 100,
      line: attribute.line,
    });
  }
  return out;
}

function smallSlate400Sites(): string[] {
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
        if (!isNormalSizeText(attribute.classes)) continue;
        found.push(`${path.relative(CLIENT_SRC, full)}:${attribute.line}`);
      }
    }
  };
  walk(CLIENT_SRC);
  return found;
}

describe("muted text does not get quieter", () => {
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
    const audited = [
      "pages/projects/weekly-reports-page.tsx",
      "pages/reports/monday-showcase/variants.tsx",
      "pages/reports/region-report-page.tsx",
    ];

    const failures: string[] = [];
    for (const file of audited) {
      for (const pair of statedPairs(path.join(CLIENT_SRC, file))) {
        if (pair.ratio < 4.5) {
          failures.push(`${file}:${pair.line} text-${pair.fg} on bg-${pair.bg} → ${pair.ratio}:1`);
        }
      }
    }

    expect(failures, "audited pages still carry small text below the 4.5:1 AA minimum").toEqual([]);
  });

  it("still finds pairs to judge in those files — an empty scan would assert nothing", () => {
    // The scanner skips ternaries and opacity-modified tokens, both for good reason. Skip too much and
    // the assertion above passes over a file it never actually read.
    expect(
      statedPairs(path.join(CLIENT_SRC, "pages/reports/region-report-page.tsx")).length,
    ).toBeGreaterThanOrEqual(3);
  });
});
