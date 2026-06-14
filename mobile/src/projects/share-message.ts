// The text body placed in the OS share sheet for a public photo-share link. Kept pure (no RN imports)
// so it's unit-testable. The url is included in the message so it survives every share target
// (Messages, Mail, Copy) — RN Share also passes `url` separately on iOS.
export function buildShareMessage(url: string, photoCount: number): string {
  const noun = photoCount === 1 ? "photo" : "photos";
  return `T-Rock project ${photoCount} ${noun}: ${url}`;
}
