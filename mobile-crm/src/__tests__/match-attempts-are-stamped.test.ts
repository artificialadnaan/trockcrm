import fs from "fs";
import path from "path";
import * as ts from "typescript";

/**
 * Every property lookup carries a generation, and every settlement checks it.
 *
 * The capture screen can have two lookups in flight. A rep who abandons one for the company fallback
 * lands back on `idle` — `location.reset()` re-renders "Find this property" — and can start another
 * before the first returns. TanStack cancels nothing and still calls the hook's callbacks, so a late
 * result from the abandoned attempt would otherwise be applied: overwriting the newer attempt's address
 * and matches, or reattaching the visit to a target the rep had already left behind.
 *
 * The fix is a stamp per attempt, mirroring `use-current-location`'s own `locateGeneration`. It has one
 * failure mode, and it is not arithmetic: a NEW `runMatch.mutate(...)` call site that forgets to carry
 * the stamp. Nothing about that looks wrong in a diff, and the symptom is a stale result applied under
 * a race that is hard to reproduce by hand.
 *
 * So this asserts the DISCIPLINE rather than the comparison. A unit test of `a === b` would pass
 * forever while the third call site quietly went unstamped; a guard that reads the call sites cannot.
 *
 * WHAT IT ASSERTS:
 *   - every `runMatch.mutate(...)` passes a `generation` property;
 *   - both settlement handlers compare that generation before doing anything;
 *   - the abandon path advances the counter, which is what retires an in-flight attempt.
 */

const SCREEN = path.resolve(__dirname, "../../app/(app)/prospect.tsx");

function parse(): ts.SourceFile {
  const text = fs.readFileSync(SCREEN, "utf8");
  const sf = ts.createSourceFile(SCREEN, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const syntactic = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  // A parse failure FAILS rather than skips — the sibling guards learned that the hard way (#958).
  expect(syntactic).toHaveLength(0);
  return sf;
}

/** Every `runMatch.mutate(...)` call in the screen, with the argument it was given. */
function mutateCalls(sf: ts.SourceFile): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "mutate" &&
      ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === "runMatch"
    ) {
      calls.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return calls;
}

describe("every property lookup is stamped, and every settlement checks the stamp", () => {
  it("finds the call sites at all, so a broken walker cannot pass as clean", () => {
    expect(mutateCalls(parse()).length).toBeGreaterThanOrEqual(2);
  });

  it("passes a generation at every runMatch.mutate call site", () => {
    const unstamped = mutateCalls(parse())
      .filter((call) => {
        const arg = call.arguments[0];
        if (!arg || !ts.isObjectLiteralExpression(arg)) return true;
        return !arg.properties.some(
          (p) => p.name && (ts.isIdentifier(p.name) ? p.name.text : p.name.getText()) === "generation",
        );
      })
      .map((call) => {
        const { line } = call.getSourceFile().getLineAndCharacterOfPosition(call.getStart());
        return `prospect.tsx:${line + 1}`;
      });
    expect(unstamped).toEqual([]);
  });

  it("advances the counter on each attempt, so two in flight are distinguishable", () => {
    // `++matchGeneration.current` inline in the payload: the stamp and the bump cannot drift apart
    // because they are the same expression.
    const text = fs.readFileSync(SCREEN, "utf8");
    const stamps = text.match(/generation:\s*\+\+matchGeneration\.current/g) ?? [];
    expect(stamps.length).toBe(mutateCalls(parse()).length);
  });

  it("compares the generation in BOTH settlement handlers before applying anything", () => {
    // Success is the dangerous one — it writes the address, the matches and the target. Error is
    // included because it clears the retry guard and posts a message about a lookup nobody is waiting
    // on any more.
    const text = fs.readFileSync(SCREEN, "utf8");
    const guards = text.match(/variables\.generation !== matchGeneration\.current/g) ?? [];
    expect(guards.length).toBe(2);
  });

  it("retires the in-flight attempt when the rep takes the company fallback", () => {
    // Without this the escape hatch only stops the FIX; the lookup it started would still land.
    const text = fs.readFileSync(SCREEN, "utf8");
    expect(text).toContain("matchGeneration.current++");
  });
});
