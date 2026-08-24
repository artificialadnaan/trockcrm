// A FIXTURE FOR `muted-text-contrast.test.ts`, read as TEXT and never rendered.
//
// A `className` does not have to contain its classes. Routing them through a lookup table keyed on state
// is the ordinary way to write a variant map in this codebase — `STATE_BADGE[row.state]` on the weekly
// reports page is exactly this shape — and a scanner that reads only the literals inside the attribute
// sees `text-xs` and nothing else.
//
// That is not a corner case, it is a blind spot with a fixed cost: the `dismissed` entry of that real table
// was one of the sites this PR fixed, and reverting it to `text-slate-400` left the whole suite green,
// INCLUDING the ratchet whose entire job is to catch that. Verified by making the edit and watching 6/6 pass.
//
// Deliberately carries a failing pair. Nothing imports it, so nothing renders it.

const TONE: Record<"muted" | "loud", string> = {
  muted: "bg-slate-100 text-slate-500",
  loud: "bg-slate-900 text-white",
};

export function ClassConstantLookupFixture({ tone }: { tone: "muted" | "loud" }) {
  return (
    <span className={`text-xs ${TONE[tone]}`}>
      classes reached only by following the reference out of the attribute
    </span>
  );
}
