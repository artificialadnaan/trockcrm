import { getOwnerInitialColor } from "@trock-crm/shared/types";
import { cn } from "@/lib/utils";

function ownerInitials(label: string) {
  return label
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "TR";
}

export function OwnerLabel({
  ownerId,
  ownerName,
  className,
}: {
  ownerId?: string | null;
  ownerName?: string | null;
  className?: string;
}) {
  const label = ownerName?.trim() || (ownerId ? `Owner ID: ${ownerId}` : "Unassigned");
  const hasOwner = Boolean(ownerId || ownerName?.trim());
  const ownerColor = hasOwner ? getOwnerInitialColor(ownerId ?? ownerName) : null;

  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-black",
          hasOwner ? "text-white" : "bg-slate-100 text-slate-500 ring-1 ring-slate-200"
        )}
        style={ownerColor ? { backgroundColor: ownerColor.backgroundColor, color: ownerColor.textColor } : undefined}
        aria-hidden="true"
      >
        {hasOwner ? ownerInitials(label) : "UA"}
      </span>
      <span className={cn("truncate text-xs font-bold", hasOwner ? "text-slate-700" : "text-slate-500")}>
        {label}
      </span>
    </span>
  );
}
