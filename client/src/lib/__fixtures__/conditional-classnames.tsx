// A FIXTURE FOR `muted-text-contrast.test.ts`, read as TEXT and never rendered.
//
// It exists because the contrast scanner used to discard any conditional `className` whole, and the two
// shapes below are the reason it must not go back to doing that — nor to the naive opposite, pairing
// tokens that belong to opposite branches:
//
//   * the FALSE POSITIVE that motivated the old blanket skip. `bg-white/20 text-white` and its else-branch
//     are two different rendered states; reading them as one string reported white-on-white at 1.0:1.
//   * the REGRESSION the blanket skip allowed. A badge whose only low-contrast pair lives inside a ternary
//     was invisible to the guard, which is how `text-slate-500` on `bg-slate-100` (4.34:1) could have gone
//     back in unnoticed.
//
// Deliberately carries a failing pair. Nothing imports it, so nothing renders it.

export function ConditionalClassNamesFixture({ dark, snapshot }: { dark: boolean; snapshot: boolean }) {
  return (
    <>
      <span className={`text-xs ${dark ? "bg-white/20 text-white" : "bg-slate-800 text-white"}`}>
        opacity-modified in one branch, resolvable in the other
      </span>
      <span
        className={`text-[9px] font-semibold uppercase ${
          snapshot ? "bg-slate-100 text-slate-500" : "bg-indigo-50 text-indigo-600"
        }`}
      >
        below AA in one branch, comfortably above it in the other
      </span>
    </>
  );
}
