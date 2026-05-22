export interface OwnerInitialColor {
  id: string;
  backgroundColor: string;
  textColor: string;
}

export const OWNER_INITIAL_COLOR_PALETTE = [
  { id: "red", backgroundColor: "#B91C1C", textColor: "#FFFFFF" },
  { id: "amber", backgroundColor: "#B45309", textColor: "#FFFFFF" },
  { id: "emerald", backgroundColor: "#047857", textColor: "#FFFFFF" },
  { id: "teal", backgroundColor: "#0F766E", textColor: "#FFFFFF" },
  { id: "sky", backgroundColor: "#0369A1", textColor: "#FFFFFF" },
  { id: "blue", backgroundColor: "#1D4ED8", textColor: "#FFFFFF" },
  { id: "violet", backgroundColor: "#6D28D9", textColor: "#FFFFFF" },
  { id: "fuchsia", backgroundColor: "#A21CAF", textColor: "#FFFFFF" },
  { id: "rose", backgroundColor: "#BE123C", textColor: "#FFFFFF" },
  { id: "olive", backgroundColor: "#4D7C0F", textColor: "#FFFFFF" },
  { id: "copper", backgroundColor: "#7C2D12", textColor: "#FFFFFF" },
  { id: "slate", backgroundColor: "#334155", textColor: "#FFFFFF" },
] as const satisfies readonly OwnerInitialColor[];

const DEFAULT_OWNER_COLOR_KEY = "unassigned";
const FNV_32_OFFSET_BASIS = 0x811c9dc5;
const FNV_32_PRIME = 0x01000193;

function normalizeOwnerColorKey(ownerKey: string | null | undefined) {
  const normalized = ownerKey?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : DEFAULT_OWNER_COLOR_KEY;
}

function hashOwnerColorKey(ownerKey: string) {
  let hash = FNV_32_OFFSET_BASIS;
  for (let index = 0; index < ownerKey.length; index += 1) {
    hash ^= ownerKey.charCodeAt(index);
    hash = Math.imul(hash, FNV_32_PRIME);
  }
  return hash >>> 0;
}

export function getOwnerInitialColor(ownerKey: string | null | undefined): OwnerInitialColor {
  const normalizedKey = normalizeOwnerColorKey(ownerKey);
  return OWNER_INITIAL_COLOR_PALETTE[
    hashOwnerColorKey(normalizedKey) % OWNER_INITIAL_COLOR_PALETTE.length
  ];
}
