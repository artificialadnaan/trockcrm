import type { Contact } from "@/hooks/use-contacts";

export const CATEGORY_LABELS: Record<string, string> = {
  client: "Client",
  subcontractor: "Subcontractor",
  architect: "Architect",
  property_manager: "Property Manager",
  regional_manager: "Regional Manager",
  vendor: "Vendor",
  consultant: "Consultant",
  influencer: "Influencer",
  other: "Other",
};

export const CATEGORY_COLORS: Record<string, string> = {
  client: "bg-blue-100 text-blue-800",
  subcontractor: "bg-orange-100 text-orange-800",
  architect: "bg-purple-100 text-purple-800",
  property_manager: "bg-green-100 text-green-800",
  regional_manager: "bg-teal-100 text-teal-800",
  vendor: "bg-yellow-100 text-yellow-800",
  consultant: "bg-indigo-100 text-indigo-800",
  influencer: "bg-pink-100 text-pink-800",
  other: "bg-gray-100 text-gray-800",
};

export const ASSOCIATION_ROLES = [
  "Decision Maker",
  "Site Contact",
  "Estimator",
  "Project Manager",
  "Superintendent",
  "Accounts Payable",
  "Owner Rep",
  "Architect",
  "Other",
];

export const MATCH_TYPE_LABELS: Record<string, string> = {
  exact_email: "Exact Email Match",
  fuzzy_name: "Similar Name",
  fuzzy_phone: "Similar Phone",
  company_match: "Same Company + Name",
};

export function fullName(contact: { firstName: string; lastName: string }): string {
  return `${contact.firstName} ${contact.lastName}`.trim();
}

export function contactInitials(contact: { firstName: string; lastName: string }): string {
  return `${contact.firstName.charAt(0)}${contact.lastName.charAt(0)}`.toUpperCase();
}

export function formatPhone(phone: string | null): string {
  if (!phone) return "";
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return phone;
}

export function contactLocation(contact: { city: string | null; state: string | null }): string {
  if (contact.city && contact.state) return `${contact.city}, ${contact.state}`;
  return contact.city ?? contact.state ?? "";
}

export function confidenceLabel(score: string | number): string {
  const s = typeof score === "string" ? parseFloat(score) : score;
  if (s >= 0.9) return "Very High";
  if (s >= 0.8) return "High";
  if (s >= 0.7) return "Medium";
  return "Low";
}

export function confidenceColor(score: string | number): string {
  const s = typeof score === "string" ? parseFloat(score) : score;
  if (s >= 0.9) return "text-red-600";
  if (s >= 0.8) return "text-orange-600";
  if (s >= 0.7) return "text-yellow-600";
  return "text-gray-600";
}
