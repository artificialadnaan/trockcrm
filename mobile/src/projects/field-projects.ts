// Ported verbatim (pure logic, RN-safe) from client-field/src/lib/field-projects.ts.
// Types + photo categories + grouping/filtering/formatting utilities shared by the
// projects list, project detail gallery, capture screen, and report builder.

export type FieldProject = {
  id: string;
  /** RAW deals.deal_number — the HubSpot id ("HS-…") for HubSpot-imported deals. Never display this; render `projectNumber`. */
  dealNumber: string;
  /** The human-facing project number to display (canonical DFW/ATL), or null when pending. Server-resolved. */
  projectNumber: string | null;
  name: string;
  /** `deals.is_change_order` — the AUTHORITY for the change-order display relabel; never infer it from the name. */
  isChangeOrder: boolean;
  /**
   * `deals.scope_title`. Travels WITH the flag: the relabel front-loads "Change Order N", and this is
   * the only field left saying WHICH one. Also SEARCHED on the Projects list, so without it a crew can
   * type the scope phrase, match, and get a row that cannot explain the hit.
   */
  scopeTitle: string | null;
  propertyName: string | null;
  propertyAddress: string | null;
  stage: string;
  lastActivityAt: string | null;
  photoCount: number;
  starred: boolean;
  /** Owning office of this (possibly cross-office) project row — server-stamped on every field read. */
  officeId: string;
  officeSlug: string;
  /** Great-circle distance in miles from the device — set ONLY on rows from the nearby endpoint; absent elsewhere. */
  distanceMiles?: number | null;
};

/**
 * Field-app distance label for a nearby project: "<x.x> mi" under 10 miles (one decimal so close jobs
 * stay distinguishable), rounded whole miles at/above 10. Returns null when there's no usable distance
 * (non-nearby rows), so the caller renders nothing.
 */
export function formatDistanceMiles(mi?: number | null): string | null {
  if (mi == null || !Number.isFinite(mi)) return null;
  return mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi)} mi`;
}

/**
 * The corrective-action affordance to render on a project's scorecard row, gated on server authorization.
 * The responder endpoint is restricted to the assigned super/PM (or an admin/director) — so only a viewer the
 * server says CAN respond (`canRespond`) gets a TAPPABLE affordance that routes to the response screen; a
 * viewer who can't gets the same status as NON-tappable text (routing there would only 403 → a load error).
 *
 *  - "open_tappable"   → OPEN card, viewer can respond   → "Corrective action required", routes.
 *  - "open_status"     → OPEN card, viewer can't respond → "Corrective action required", read-only.
 *  - "closed_tappable" → CLOSED card, viewer can respond → "Resolved" badge, routes (read-only screen).
 *  - "closed_status"   → CLOSED card, viewer can't respond → "Resolved" badge, read-only.
 *  - "none"            → no corrective action on this card.
 */
export type CorrectiveAffordance =
  | "open_tappable"
  | "open_status"
  | "closed_tappable"
  | "closed_status"
  // Between open and closed since the approval gate: the responder has answered and an approver is
  // reviewing. Never TAPPABLE — there is nothing for the responder to do until it comes back — but it must
  // still show, or the project screen looks as though the workflow simply ended.
  | "awaiting_status"
  | "none";

export function correctiveAffordance(
  status: string | undefined,
  canRespond: boolean,
): CorrectiveAffordance {
  if (status === "corrective_action_open") return canRespond ? "open_tappable" : "open_status";
  if (status === "corrective_action_submitted") return "awaiting_status";
  if (status === "corrective_action_closed") return canRespond ? "closed_tappable" : "closed_status";
  return "none";
}

/**
 * Off-office projects are VIEW-ONLY until cross-office WRITES ship: the write endpoints (star,
 * generate-report, add-photo) are single-office and target the user's writable office schema, so a
 * write to a project owned by a different office 404s server-side. Suppress those actions for off-office
 * rows. When the writable office can't be resolved we err on the side of view-only.
 */
export function isProjectOffOffice(
  project: Pick<FieldProject, "officeId">,
  writableOfficeId: string | null | undefined,
): boolean {
  if (!writableOfficeId) return true;
  return project.officeId !== writableOfficeId;
}

export type FieldCaptureTarget = {
  id: string;
  type: "lead" | "opportunity" | "deal";
  name: string;
  /** `deals.is_change_order` — deal rows only; the AUTHORITY for the change-order display relabel. */
  isChangeOrder?: boolean | null;
  /** `deals.scope_title` — deal rows only, same gate as the flag above; a lead has no scope title. */
  scopeTitle?: string | null;
  recordNumber: string | null;
  stageName: string | null;
  companyName: string | null;
  lastUpdatedAt: string;
  distanceMiles?: number | null;
};

/**
 * The display name for a capture target, with the change-order relabel GATED on the target being a deal.
 *
 * A picker row mixes all three types, and only a `deal` can be a generated change-order child: a `lead` is
 * a leads-table row named by a human, and the server explicitly excludes opportunities from the `deal`
 * type (`d.pipeline_disposition IS DISTINCT FROM 'opportunity'` in field/projects-service.ts) while a CO
 * child is always Won. Rewriting every type would mangle a lead someone legitimately called
 * "Lobby — Change Order 1".
 */
export function captureTargetDisplayName(
  target: Pick<FieldCaptureTarget, "type" | "name"> & { isChangeOrder?: boolean | null },
): string {
  // The type gate stays: only a deal can be a generated change-order child, and a lead a human named
  // "Lobby — Change Order 1" must render as typed. `isChangeOrder` then makes the DEAL branch
  // authoritative instead of syntactic.
  //
  // Capture-target search DOES carry the flag (files/service.ts mapDealRow projects
  // `isChangeOrder: row.isChangeOrder === true`), so picker rows are authoritative, not guesses. The
  // parameter stays optional only for callers holding a partial target; when it is absent the name
  // fallback is the documented degradation, not the normal path.
  return target.type === "deal" ? formatDealDisplayName(target.name, target.isChangeOrder) : target.name;
}

export type FieldPhoto = {
  id: string;
  category: "photo";
  photoCategory: string | null;
  subcategory: string | null;
  displayName: string;
  mimeType: string;
  fileSizeBytes: number | null;
  fileExtension: string | null;
  dealId: string | null;
  leadId: string | null;
  description: string | null;
  tags?: string[];
  takenAt: string | null;
  createdAt: string;
  uploadedBy: string;
  uploaderName: string;
  uploaderAvatarUrl: string | null;
  latitude: string | null;
  longitude: string | null;
  address: string | null;
  addressSource: "exif" | "live_gps" | "deal_fallback" | "manual_override" | null;
  geocodedAt: string | null;
  procoreSyncStatus: "pending" | "synced" | "failed" | "skipped" | null;
  deletedAt: string | null;
  /** Thumbnail URL for the grid. */
  imageUrl: string | null;
  /** High-res URL for the zoomable full-screen viewer (may equal imageUrl for R2 originals). */
  fullImageUrl?: string | null;
};

export type PhotoGrouping = "date" | "category" | "uploader" | "none";

// The 6 phase categories offered for capture. Kept in sync with the shared
// source of truth (shared/src/types/enums.ts PHOTO_CATEGORY_OPTIONS); the Expo
// bundle can't import the workspace `shared` package, so this is a deliberate
// mirror — update both together.
export const PHOTO_CATEGORIES = [
  { value: "estimating", label: "Estimating" },
  { value: "preconstruction", label: "Preconstruction" },
  { value: "construction", label: "Construction" },
  { value: "final_completion", label: "Final Completion" },
  { value: "punch", label: "Punch" },
  { value: "issues", label: "Issues" },
] as const;

// Legacy categories — no longer offered for capture, retained only so photos
// tagged before the phase rollout still resolve a human label.
export const LEGACY_PHOTO_CATEGORIES = [
  { value: "before", label: "Before" },
  { value: "after", label: "After" },
  { value: "progress", label: "Progress" },
  { value: "site_visit", label: "Site Visit" },
  { value: "damage", label: "Damage" },
  { value: "safety", label: "Safety" },
  { value: "delivery", label: "Delivery" },
  { value: "other", label: "Other" },
] as const;

export function groupCaptureTargets(targets: FieldCaptureTarget[]) {
  return {
    lead: targets.filter((target) => target.type === "lead"),
    opportunity: targets.filter((target) => target.type === "opportunity"),
    deal: targets.filter((target) => target.type === "deal"),
  };
}

/**
 * Field-app label for a project's number: "#<number>" when there is a canonical number, else a
 * muted "Project pending". The server already resolves `projectNumber` (canonical DFW/ATL, never the
 * HubSpot id), so this only handles the empty/pending case.
 */
export function projectNumberLabel(projectNumber: string | null | undefined): string {
  const trimmed = projectNumber?.trim();
  return trimmed ? `#${trimmed}` : "Project pending";
}

// Kept in sync with the shared source of truth (shared/src/types/deal-display-name.ts); the Expo bundle
// can't import the workspace `shared` package, so this is a deliberate mirror — update both together.
// A drift guard lives in shared/src/types/deal-display-name.test.ts, which reads this file.
const EM_DASH = "—";
// The ordinal is `[1-9]\d*` — exactly what nextChildOrdinal() can emit (`COUNT(*)::int + 1`, always a
// positive unpadded decimal). "Change Order 0" / "Change Order 01" are human-typed and survive as-is.
const CHANGE_ORDER_NAME_SUFFIX = /\s*—\s*Change Order\s+([1-9]\d*)\s*$/;

/**
 * The display form of a deal/project name. A change order is a real CHILD deal whose stored name is
 * built by APPENDING "<parent> — Change Order N" (server/src/modules/deals/change-order-service.ts), so in
 * the project list — where a row is one truncated line — a change order is indistinguishable from its
 * parent. Move the label to the FRONT, where truncation can't eat it.
 *
 *     "Tides Park Lane — Change Order 1"  ->  "Change Order 1 — Tides Park Lane"
 *
 * It peels every generated trailing suffix rather than short-circuiting on a name that merely looks
 * already-formatted, so a parent a human named "Change Order 7 — Lobby" still gets its child's real label
 * moved to the front.
 *
 * POST-CONDITION — the output never ends in a generated suffix; that invariant is what makes this
 * idempotent, and it is ENFORCED below rather than assumed. Rejoining the pieces can re-create a trailing
 * suffix when what precedes it is itself label-shaped (" — Change Order 1 — Change Order 2" and
 * "Change Order 1 — Change Order 2" both do), which would oscillate forever between two spellings. Such a
 * degenerate name is returned UNCHANGED, which is trivially a fixed point.
 *
 * DISPLAY-ONLY: the stored `deals.name` is unchanged, so this must never be applied to a value that gets
 * written back (a walk title, a scorecard draft's dealName, a report cover, a nav param) — only to the
 * text a screen renders. Total, and it leaves every non-generated name byte for byte.
 *
 * `isChangeOrder` — pass it whenever the payload carries it. `deals.is_change_order` is the AUTHORITY;
 * the name is only evidence. `false` returns the name unchanged whatever it looks like, `true` peels, and
 * `undefined`/`null` falls back to syntax — an explicit degradation for payloads without the flag.
 */
export function formatDealDisplayName(name: string, isChangeOrder?: boolean | null): string;
export function formatDealDisplayName(
  name: string | null | undefined,
  isChangeOrder?: boolean | null
): string | null | undefined;
export function formatDealDisplayName(
  name: string | null | undefined,
  isChangeOrder?: boolean | null
): string | null | undefined {
  if (typeof name !== "string" || name.length === 0) return name;
  if (isChangeOrder === false) return name;
  const labels: string[] = [];
  let rest = name;
  for (;;) {
    const match = CHANGE_ORDER_NAME_SUFFIX.exec(rest);
    if (!match) break;
    labels.push(`Change Order ${match[1]}`);
    rest = rest.slice(0, match.index);
  }
  if (labels.length === 0) return name;
  const base = rest.trim();
  const candidate = (base.length === 0 ? labels : [...labels, base]).join(` ${EM_DASH} `);
  return CHANGE_ORDER_NAME_SUFFIX.test(candidate) ? name : candidate;
}

/**
 * `deals.is_change_order` across a ROUTER PARAM, as a matched pair.
 *
 * Expo router params are strings, so the flag has to be encoded — and this is where it kept getting
 * corrupted. `false` is AUTHORITATIVE downstream: it asserts "not a change order" and suppresses the
 * relabel. So an UNKNOWN flag must never be encoded as something that decodes to `false`. Twice now an
 * inline ternary got that backwards (`toStr(undefined)` -> `""` -> `"" === "1"` -> false), which is
 * exactly the unknown-becomes-an-assertion bug, wearing a router param instead of a serializer.
 *
 * Encode returns `undefined` for unknown so the caller can OMIT the key; decode treats anything that is
 * not exactly "1"/"0" — absent, "", junk — as unknown. Use these two rather than hand-rolling either half.
 */
export function encodeChangeOrderParam(flag: boolean | null | undefined): "1" | "0" | undefined {
  return flag === true ? "1" : flag === false ? "0" : undefined;
}

export function decodeChangeOrderParam(value: string | string[] | undefined): boolean | undefined {
  if (value === "1") return true;
  if (value === "0") return false;
  return undefined;
}

/**
 * Split the three project sources into non-overlapping display sections with precedence
 * Nearby > Starred > All: a project shown in Nearby is removed from Starred and All; a starred project
 * is removed from All — so nothing renders twice. `hasSections` is true when any header section (Nearby
 * or the deduped Starred) will render, which the screen uses to decide whether to label the main list and
 * whether to show the "no projects" empty state.
 */
export function partitionProjectSections(
  nearby: FieldProject[],
  starred: FieldProject[],
  all: FieldProject[],
): { nearby: FieldProject[]; starred: FieldProject[]; all: FieldProject[]; hasSections: boolean } {
  const nearbyIds = new Set(nearby.map((p) => p.id));
  const starredIds = new Set(starred.map((p) => p.id));
  const visibleStarred = starred.filter((p) => !nearbyIds.has(p.id));
  const visibleAll = all.filter((p) => !nearbyIds.has(p.id) && !starredIds.has(p.id));
  return {
    nearby,
    starred: visibleStarred,
    all: visibleAll,
    hasSections: nearby.length > 0 || visibleStarred.length > 0,
  };
}

/**
 * Decide which projects (if any) the "Nearby" section should render. A ranked "nearest 3" must be
 * suppressed whenever it can't be trusted:
 *  - while searching (Nearby is a browse-mode affordance),
 *  - when any office was omitted from the cross-office fan-out (`degradedOffices` non-empty) — the
 *    missing office could hold the actual closest job, so a partial ranking is misleading,
 *  - when the latest fetch errored — React Query RETAINS the prior data on a failed refetch (e.g. every
 *    office 503s), so without this gate a stale ranking would keep rendering as if fresh.
 */
export function selectNearbySource(args: {
  searching: boolean;
  isError: boolean;
  projects?: FieldProject[];
  degradedOffices?: string[];
}): FieldProject[] {
  const { searching, isError, projects, degradedOffices } = args;
  if (searching || isError || (degradedOffices?.length ?? 0) > 0) return [];
  return projects ?? [];
}

export function relativeDate(value: string | null) {
  if (!value) return "no recent activity";
  const diffMs = Date.now() - new Date(value).getTime();
  const day = 24 * 60 * 60 * 1000;
  if (diffMs < day) return "today";
  if (diffMs < day * 2) return "yesterday";
  if (diffMs < day * 7) return `${Math.floor(diffMs / day)} days ago`;
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function categoryLabel(value: string | null) {
  if (!value) return "Uncategorized";
  const match = [...PHOTO_CATEGORIES, ...LEGACY_PHOTO_CATEGORIES].find((category) => category.value === value);
  return match?.label ?? value.replace(/_/g, " ");
}

function ordinal(day: number) {
  if (day > 3 && day < 21) return `${day}th`;
  if (day % 10 === 1) return `${day}st`;
  if (day % 10 === 2) return `${day}nd`;
  if (day % 10 === 3) return `${day}rd`;
  return `${day}th`;
}

export function dateHeading(value: string) {
  const date = new Date(value);
  return `${date.toLocaleDateString("en-US", { weekday: "long" })}, ${date.toLocaleDateString("en-US", { month: "long" })} ${ordinal(date.getDate())}, ${date.getFullYear()}`;
}

export function photoTime(photo: FieldPhoto) {
  const t = Date.parse(photo.takenAt ?? photo.createdAt ?? "");
  return Number.isNaN(t) ? 0 : t;
}

/** Parse a photo timestamp to a YYYY-MM-DD day, tolerating a missing/invalid value. NEVER throws — a bad
 *  timestamp must fall into an "unknown" bucket, not crash the gallery/filters with `new Date(bad).toISOString()`
 *  (a RangeError, which with no error boundary was an app-killing crash). */
export function toDayString(value: string | null | undefined): string {
  if (!value) return "";
  const t = Date.parse(value);
  if (Number.isNaN(t)) return "";
  // LOCAL day, deliberately — not toISOString(), which is UTC.
  //
  // This value is the grouping key, while the heading beside it comes from `dateHeading`, which
  // formats in local time. When those disagreed, one evening's photos split into two groups
  // rendering the SAME heading: in Dallas everything shot after 7pm rolls into the next UTC day.
  // That produced duplicate React keys and, worse, a gallery showing "Friday, July 31st" twice
  // with the day's work divided between them.
  //
  // It is also the value compared against the date-range filter, whose bounds a crew picks in
  // local terms — so a 9pm photo on the 31st was being excluded from a "31st" filter.
  const d = new Date(t);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

export function groupPhotos(photos: FieldPhoto[], grouping: PhotoGrouping) {
  const sorted = [...photos].sort((a, b) => photoTime(b) - photoTime(a));
  if (grouping === "none") return [{ label: "All photos", photos: sorted }];

  const groups = new Map<string, { label: string; photos: FieldPhoto[]; sort: number | string }>();
  for (const photo of sorted) {
    let key = "all";
    let label = "All photos";
    let sort: number | string = 0;
    if (grouping === "date") {
      const value = photo.takenAt ?? photo.createdAt;
      const day = toDayString(value);
      key = day || "unknown";
      label = day ? dateHeading(value) : "Unknown date";
      sort = photoTime(photo);
    } else if (grouping === "category") {
      key = photo.photoCategory ?? photo.subcategory ?? "uncategorized";
      label = categoryLabel(photo.photoCategory ?? photo.subcategory);
      sort = label;
    } else if (grouping === "uploader") {
      key = photo.uploadedBy;
      label = photo.uploaderName || "Unknown";
      sort = label;
    }

    const existing = groups.get(key) ?? { label, photos: [], sort };
    existing.photos.push(photo);
    if (typeof existing.sort === "number" && typeof sort === "number") existing.sort = Math.max(existing.sort, sort);
    groups.set(key, existing);
  }

  return Array.from(groups.values()).sort((a, b) => {
    if (typeof a.sort === "number" && typeof b.sort === "number") return b.sort - a.sort;
    return String(a.sort).localeCompare(String(b.sort));
  });
}

export function filterPhotos(
  photos: FieldPhoto[],
  filters: { categories: string[]; tags: string[]; uploaderIds: string[]; from: string; to: string },
) {
  const normalizedTags = filters.tags.map((tag) => tag.toLowerCase());
  return photos.filter((photo) => {
    if (filters.categories.length > 0) {
      const category = photo.photoCategory ?? photo.subcategory ?? "uncategorized";
      if (!filters.categories.includes(category)) return false;
    }
    if (filters.tags.length > 0) {
      const photoTags = (Array.isArray(photo.tags) ? photo.tags : [])
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => tag.toLowerCase());
      if (!photoTags.some((tag) => normalizedTags.includes(tag))) return false;
    }
    if (filters.uploaderIds.length > 0 && !filters.uploaderIds.includes(photo.uploadedBy)) return false;
    const day = toDayString(photo.takenAt ?? photo.createdAt);
    if (filters.from && (!day || day < filters.from)) return false;
    if (filters.to && (!day || day > filters.to)) return false;
    return true;
  });
}

/** Distinct uploaders present in a photo set (for the uploader filter chips). */
export function uploadersOf(photos: FieldPhoto[]): { id: string; name: string }[] {
  const map = new Map<string, string>();
  for (const photo of photos) {
    if (!map.has(photo.uploadedBy)) map.set(photo.uploadedBy, photo.uploaderName || "Unknown");
  }
  return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
}

/** Distinct tags present in a photo set (for the tag filter chips). */
export function tagsOf(photos: FieldPhoto[]): string[] {
  const set = new Set<string>();
  for (const photo of photos) {
    // Normalize the CONTAINER with Array.isArray (not just `?? []`): a non-array tags value — a bare string
    // ("floor,elevation") or a malformed object — would otherwise be iterated by for..of (a string yields its
    // characters as 1-char "tags"; a non-iterable object throws). Then keep only real, non-empty string
    // ELEMENTS — a null/non-string element would crash the sort (`null.localeCompare`) or render as an invalid
    // React child in the filter chips.
    for (const tag of Array.isArray(photo.tags) ? photo.tags : []) {
      if (typeof tag === "string" && tag.length > 0) set.add(tag);
    }
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}
