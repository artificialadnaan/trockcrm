// All query keys are scoped by user id so a shared device never leaks one field
// user's cached projects/photos to the next signed-in user (cache is also fully
// cleared on sign-out — see AuthContext.signOut).
export const qk = {
  projects: (uid: string, search: string) => ["projects", uid, search] as const,
  starred: (uid: string) => ["starred", uid] as const,
  // Exact coordinates — NOT rounded. Location only updates on discrete events (focus / app-active /
  // pull-to-refresh), never a continuous watch, so there's no jitter stream to debounce; rounding would
  // instead let a real move within the rounding cell keep the same key and leave Nearby ranked for the
  // previous position. Keying on the exact fix means any position change busts the cache and refetches.
  nearby: (uid: string, lat: number, lng: number) =>
    ["nearby", uid, lat, lng] as const,
  projectPhotos: (uid: string, dealId: string) => ["projectPhotos", uid, dealId] as const,
  projectReports: (uid: string, dealId: string) => ["projectReports", uid, dealId] as const,
  projectScorecards: (uid: string, dealId: string) => ["projectScorecards", uid, dealId] as const,
  scorecard: (uid: string, id: string) => ["scorecard", uid, id] as const,
  pending: (uid: string) => ["pending", uid] as const,
  projectTags: (uid: string, dealId: string, q: string) => ["projectTags", uid, dealId, q] as const,
  targets: (uid: string, search: string) => ["targets", uid, search] as const,
  nearbyTargets: (uid: string, latitude: number | null, longitude: number | null, limit: number) =>
    ["nearbyTargets", uid, latitude, longitude, limit] as const,
};
