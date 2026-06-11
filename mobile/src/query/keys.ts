// All query keys are scoped by user id so a shared device never leaks one field
// user's cached projects/photos to the next signed-in user (cache is also fully
// cleared on sign-out — see AuthContext.signOut).
export const qk = {
  projects: (uid: string, search: string) => ["projects", uid, search] as const,
  starred: (uid: string) => ["starred", uid] as const,
  projectPhotos: (uid: string, dealId: string) => ["projectPhotos", uid, dealId] as const,
  projectReports: (uid: string, dealId: string) => ["projectReports", uid, dealId] as const,
  pending: (uid: string) => ["pending", uid] as const,
  projectTags: (uid: string, dealId: string, q: string) => ["projectTags", uid, dealId, q] as const,
  targets: (uid: string, search: string) => ["targets", uid, search] as const,
};
