// A FIXTURE FOR `muted-text-contrast.test.ts`, read as TEXT and never rendered.
//
// WCAG's "large text" threshold is 18.66px WHEN BOLD, and bold is often conditional. Judging weight on the
// flattened class string means a conditionally-bold element looks bold in every state — so a 20px label is
// waved through as large text (3:1) when its normal-weight branch is normal text and owes 4.5:1.
//
// 4.34:1 below, which passes as large text and fails as normal text. The bold branch is correctly skipped;
// the plain branch must be measured and must fail.
//
// Deliberately carries a failing pair. Nothing imports it, so nothing renders it.

export function ConditionalWeightFixture({ loud }: { loud: boolean }) {
  return (
    <span className={`text-xl bg-slate-100 text-slate-500 ${loud ? "font-bold" : ""}`}>
      large text only in the branch that says so
    </span>
  );
}
