export type DealRegionSlug = "west_coast" | "central" | "east_coast";

export type DealRegionDefinition = {
  slug: DealRegionSlug;
  name: string;
  states: readonly string[];
  displayOrder: number;
};

export const DEAL_REGION_DEFINITIONS = [
  {
    slug: "west_coast",
    name: "West Coast",
    states: ["WA", "OR", "CA", "NV", "ID", "MT", "WY", "UT", "CO", "AZ", "NM", "AK", "HI"],
    displayOrder: 1,
  },
  {
    slug: "central",
    name: "Central",
    states: ["ND", "SD", "NE", "KS", "OK", "TX", "MN", "IA", "MO", "AR", "LA"],
    displayOrder: 2,
  },
  {
    slug: "east_coast",
    name: "East Coast",
    states: ["WI", "IL", "MI", "IN", "OH", "KY", "TN", "MS", "AL", "GA", "FL", "WV", "VA", "NC", "SC", "PA", "NY", "ME", "VT", "NH", "MA", "RI", "CT", "NJ", "DE", "MD"],
    displayOrder: 3,
  },
] as const satisfies readonly DealRegionDefinition[];

const STATE_NAME_TO_CODE: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
};

const REGION_BY_STATE = new Map<string, DealRegionDefinition>(
  DEAL_REGION_DEFINITIONS.flatMap((region) => region.states.map((state) => [state, region] as const))
);

export function normalizeUsStateCode(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;

  const upper = normalized.toUpperCase();
  if (/^[A-Z]{2}$/.test(upper)) return upper;

  return STATE_NAME_TO_CODE[normalized.toLowerCase()] ?? null;
}

export function getDealRegionForState(value: unknown): DealRegionDefinition | null {
  const stateCode = normalizeUsStateCode(value);
  return stateCode ? REGION_BY_STATE.get(stateCode) ?? null : null;
}

export function getDealRegionSlugForState(value: unknown): DealRegionSlug | null {
  return getDealRegionForState(value)?.slug ?? null;
}
