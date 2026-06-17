export type SortDirection = "asc" | "desc";
export type ColumnType = "text" | "number" | "date";

function isNullish(v: unknown): boolean {
  return v === null || v === undefined;
}

// Nullish (and "" for text) always sorts LAST, in both directions: the null check
// returns before the direction sign is applied, so a blank never floats to the top
// on ascending. Blanks are "unknown", never "0"/"zzz".
export function compareText(
  a: string | null | undefined,
  b: string | null | undefined,
  dir: SortDirection,
): number {
  const an = isNullish(a) || a === "";
  const bn = isNullish(b) || b === "";
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  const cmp = String(a).localeCompare(String(b), undefined, { sensitivity: "base" });
  return dir === "asc" ? cmp : -cmp;
}

export function compareNumber(
  a: number | null | undefined,
  b: number | null | undefined,
  dir: SortDirection,
): number {
  const an = isNullish(a);
  const bn = isNullish(b);
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  const cmp = (a as number) - (b as number);
  return dir === "asc" ? cmp : -cmp;
}

export function compareDate(
  a: string | null | undefined,
  b: string | null | undefined,
  dir: SortDirection,
): number {
  const at = isNullish(a) ? NaN : Date.parse(a as string);
  const bt = isNullish(b) ? NaN : Date.parse(b as string);
  const an = Number.isNaN(at);
  const bn = Number.isNaN(bt);
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  const cmp = at - bt;
  return dir === "asc" ? cmp : -cmp;
}
