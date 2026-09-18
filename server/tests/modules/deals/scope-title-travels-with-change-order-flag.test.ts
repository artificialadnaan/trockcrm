import { describe, expect, it } from "vitest";
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";

/**
 * STRUCTURAL guard: on the dashboard chain, `dealScopeTitle` travels WITH `dealIsChangeOrder`.
 *
 * The flag is the authority for the change-order display relabel. Once it fires, the row reads
 * "<Parent> — Change Order N" and `deals.scope_title` is the ONLY field left that says WHICH change
 * order — so a hand-off that carries the flag and drops the title renders two siblings identically.
 * The symptom is silent in exactly the way change-order-flag-chain.test.ts describes: no error, no type
 * error (the field is optional), and the upstream query looks correct.
 *
 * This is the REMAP_DROPS_FLAG failure from that file's docblock, one column over — and it has now
 * shipped twice at the SAME line. `getDirectorDashboard`'s final `staleDeals` re-map dropped the flag
 * once (fixed, with a comment saying so), then dropped the title added beside it. A code comment did
 * not prevent the second occurrence, which is why this is a check.
 *
 * WHY FILE-SCOPED AND NOT REPO-WIDE. The pairing is NOT a global invariant: 37 object literals across
 * server/src carry the flag without the title (ai-copilot, companycam, tasks, email, the report tiers),
 * and asserting it everywhere would encode a claim this change does not make. It holds for the
 * dashboard at-risk / stale-deal / snapshot / recent-close chain, which is what this file locks.
 *
 * KEYED ON THE ENCLOSING FUNCTION CHAIN, not line number, so exemptions survive edits above them and
 * can be named after the exported function a reader recognises even when the literal sits inside a
 * nested helper (getDirectorCommissionEvidence builds its rows inside a local `runDealQuery`).
 */

const DASHBOARD_SERVICE = path.resolve(__dirname, "../../../src/modules/dashboard/service.ts");

/**
 * Functions that legitimately carry the flag WITHOUT the title. Each is a deal-row producer outside the
 * dashboard chain; the reason is recorded so a future reader does not "fix" one back into the chain.
 */
const EXEMPT: Record<string, string> = {
  getCommissionDealRollups:
    "Commission drill. Renders deal names through four row types across three DTOs " +
    "(rep-commission-drilldown.tsx); carrying the column without rendering all four would reproduce " +
    "the carried-but-not-shown defect. Deferred deliberately, not overlooked.",
  getDirectorCommissionEvidence:
    "Commission evidence drawer — same surface family as the drill above, and its rows are not all " +
    "deals (lead / activity / manager-override rows carry no deal name at all).",
  getRepWonMissingContractDate:
    "Won-unsigned reconciliation list. It ASSERTS the flag false from its own WHERE clause " +
    "(`COALESCE(d.is_change_order, false) = false`) rather than reading a column, so by construction " +
    "no row here is a change order and there is nothing for a title to disambiguate.",
};

/** Every enclosing named function/method, innermost first. Empty at top level. */
function enclosingFunctionNames(node: ts.Node): string[] {
  const names: string[] = [];
  let current: ts.Node | undefined = node;
  while (current) {
    if (
      (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) &&
      current.name &&
      ts.isIdentifier(current.name)
    ) {
      names.push(current.name.text);
    }
    // `const foo = async (...) => {...}` / `const foo = function (...) {...}`
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      current.parent &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      names.push(current.parent.name.text);
    }
    current = current.parent;
  }
  return names;
}

/** Property names set on an object literal, including shorthand (`dealScopeTitle,`). */
function propertyNames(node: ts.ObjectLiteralExpression): string[] {
  const names: string[] = [];
  for (const property of node.properties) {
    if (ts.isSpreadAssignment(property)) continue;
    const name = property.name;
    if (name && ts.isIdentifier(name)) names.push(name.text);
    else if (name && ts.isStringLiteral(name)) names.push(name.text);
  }
  return names;
}

type Site = { line: number; fns: string[] };

const label = (site: Site) => site.fns[0] ?? "<top level>";

function collect(): { paired: Site[]; unpaired: Site[] } {
  const text = fs.readFileSync(DASHBOARD_SERVICE, "utf8");
  const sf = ts.createSourceFile(DASHBOARD_SERVICE, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const paired: Site[] = [];
  const unpaired: Site[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const names = propertyNames(node);
      if (names.includes("dealIsChangeOrder")) {
        const site: Site = {
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          fns: enclosingFunctionNames(node),
        };
        (names.includes("dealScopeTitle") ? paired : unpaired).push(site);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { paired, unpaired };
}

describe("dealScopeTitle travels with dealIsChangeOrder on the dashboard chain", () => {
  const { paired, unpaired } = collect();

  it("finds the literals it exists to police, so a rename cannot make it vacuous", () => {
    // Without this the whole file passes trivially the day someone renames the field or moves the
    // producers out of service.ts — green because it inspected nothing.
    expect(paired.length).toBeGreaterThan(0);
    expect(paired.length + unpaired.length).toBeGreaterThanOrEqual(4);
  });

  it("every chain producer that carries the flag also carries the title", () => {
    // Collected, not asserted one at a time, so a failure NAMES every offending site at once.
    const offenders = unpaired
      // Exempt when ANY enclosing function is listed, so an exemption can name the exported entry
      // point rather than whichever nested helper happens to build the literal.
      .filter((site) => !site.fns.some((fn) => fn in EXEMPT))
      .map((site) => `${label(site)} (service.ts:${site.line})`);

    expect(offenders).toEqual([]);
  });

  it("every exemption still describes a real site, so the list cannot rot", () => {
    // An exemption whose function no longer carries the flag is stale: it would silently excuse a
    // FUTURE literal that happens to land in a function with the same name.
    const unpairedFns = new Set(unpaired.flatMap((site) => site.fns));
    const stale = Object.keys(EXEMPT).filter((fn) => !unpairedFns.has(fn));

    expect(stale).toEqual([]);
  });
});
