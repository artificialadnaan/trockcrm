/** Downstream Core accepts 300 characters. Preserve both site and opportunity within that budget. */
export function rfpProjectName(propertyName: string | null | undefined, opportunityName: string | null | undefined): string {
  const clean = (value: string | null | undefined) => (value ?? "").trim().replace(/\s+/g, " ");
  const property = clean(propertyName);
  let opportunity = clean(opportunityName);
  if (!property) return (opportunity || "Untitled Deal").slice(0, 300);
  if (!opportunity || property.toLowerCase() === opportunity.toLowerCase()) return property.slice(0, 300);
  for (const prefix of [property, property.slice(0, 140)]) {
    if (opportunity.toLowerCase().startsWith(`${prefix.toLowerCase()} - `)) {
      opportunity = opportunity.slice(prefix.length + 3);
      break;
    }
  }
  const site = property.slice(0, Math.min(140, 297 - Math.min(opportunity.length, 157)));
  return `${site} - ${opportunity.slice(0, 297 - site.length)}`;
}
