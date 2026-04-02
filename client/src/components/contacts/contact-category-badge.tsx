import { Badge } from "@/components/ui/badge";
import { CATEGORY_LABELS, CATEGORY_COLORS } from "@/lib/contact-utils";

interface ContactCategoryBadgeProps {
  category: string;
}

export function ContactCategoryBadge({ category }: ContactCategoryBadgeProps) {
  const label = CATEGORY_LABELS[category] ?? category;
  const colorClass = CATEGORY_COLORS[category] ?? "bg-gray-100 text-gray-800";

  return (
    <Badge variant="outline" className={`${colorClass} border-0 text-xs`}>
      {label}
    </Badge>
  );
}
