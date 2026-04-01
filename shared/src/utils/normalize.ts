export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  return phone.replace(/\D/g, "");
}

export function normalizeName(firstName: string, lastName: string): string {
  return `${firstName} ${lastName}`.toLowerCase().trim();
}
