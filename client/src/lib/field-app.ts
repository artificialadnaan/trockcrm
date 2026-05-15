function trimOrigin(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, "");
}

export function resolveFieldAppBaseUrl(
  env: { VITE_FIELD_APP_URL?: string | undefined } = (import.meta as any).env ?? {}
): string | null {
  return trimOrigin(env.VITE_FIELD_APP_URL);
}

export function buildFieldCaptureUrl(
  search: string = "",
  env: { VITE_FIELD_APP_URL?: string | undefined } = (import.meta as any).env ?? {}
): string | null {
  const baseUrl = resolveFieldAppBaseUrl(env);
  if (!baseUrl) return null;
  return `${baseUrl}/capture${search || ""}`;
}
