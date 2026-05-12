const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;

export function isUuidLike(value: string | null | undefined): boolean {
  return Boolean(value && UUID_PATTERN.test(value.trim()));
}

export function displayNameOrFallback(
  value: string | null | undefined,
  fallback = "Unknown user"
): string {
  const trimmed = value?.trim();
  if (!trimmed || isUuidLike(trimmed)) return fallback;
  return trimmed;
}

export function stripVisibleUuidFallback(
  value: string | null | undefined,
  fallback = "Linked internally"
): string {
  const trimmed = value?.trim();
  if (!trimmed || isUuidLike(trimmed)) return fallback;
  return trimmed;
}
