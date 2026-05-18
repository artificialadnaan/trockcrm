export type FieldProject = {
  id: string;
  name: string;
  dealNumber: string;
  propertyName: string | null;
  propertyAddress: string | null;
  stage: string;
  lastActivityAt: string | null;
  photoCount: number;
  starred: boolean;
};

export type FieldCaptureTarget = {
  id: string;
  type: "lead" | "opportunity" | "deal";
  name: string;
  recordNumber: string | null;
  stageName: string | null;
  companyName: string | null;
  lastUpdatedAt: string;
};

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
  imageUrl: string | null;
};

export type PhotoGrouping = "date" | "category" | "uploader" | "none";

export const PHOTO_CATEGORIES = [
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
  return PHOTO_CATEGORIES.find((category) => category.value === value)?.label ?? value.replace(/_/g, " ");
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
  return new Date(photo.takenAt ?? photo.createdAt).getTime();
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
      key = new Date(value).toISOString().slice(0, 10);
      label = dateHeading(value);
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

export function filterPhotos(photos: FieldPhoto[], filters: {
  categories: string[];
  uploaderIds: string[];
  from: string;
  to: string;
}) {
  return photos.filter((photo) => {
    if (filters.categories.length > 0) {
      const category = photo.photoCategory ?? photo.subcategory ?? "uncategorized";
      if (!filters.categories.includes(category)) return false;
    }
    if (filters.uploaderIds.length > 0 && !filters.uploaderIds.includes(photo.uploadedBy)) return false;
    const day = new Date(photo.takenAt ?? photo.createdAt).toISOString().slice(0, 10);
    if (filters.from && day < filters.from) return false;
    if (filters.to && day > filters.to) return false;
    return true;
  });
}
