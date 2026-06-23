// All query keys are scoped by user id so a shared device never leaks one field
// user's cached projects/photos to the next signed-in user (cache is also fully
// cleared on sign-out — see AuthContext.signOut).
export const qk = {
  // Coords are part of the key (exact, not rounded) so a new GPS fix refetches the list in the new
  // proximity order. Location only updates on discrete events (focus / app-active / pull-to-refresh),
  // never a continuous watch, so there's no jitter stream to debounce.
  projects: (uid: string, search: string, coords: { lat: number; lng: number } | null = null) =>
    ["projects", uid, search, coords?.lat ?? null, coords?.lng ?? null] as const,
  starred: (uid: string) => ["starred", uid] as const,
  projectPhotos: (uid: string, dealId: string) => ["projectPhotos", uid, dealId] as const,
  projectReports: (uid: string, dealId: string) => ["projectReports", uid, dealId] as const,
  pending: (uid: string) => ["pending", uid] as const,
  projectTags: (uid: string, dealId: string, q: string) => ["projectTags", uid, dealId, q] as const,
  targets: (uid: string, search: string) => ["targets", uid, search] as const,
  nearbyTargets: (uid: string, latitude: number | null, longitude: number | null, limit: number) =>
    ["nearbyTargets", uid, latitude, longitude, limit] as const,
};
