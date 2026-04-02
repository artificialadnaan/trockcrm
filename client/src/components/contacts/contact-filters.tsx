import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CATEGORY_LABELS } from "@/lib/contact-utils";
import type { ContactFilters as FilterState } from "@/hooks/use-contacts";

interface ContactFiltersProps {
  filters: FilterState;
  onFilterChange: (update: Partial<FilterState>) => void;
  onReset: () => void;
}

export function ContactFilters({ filters, onFilterChange, onReset }: ContactFiltersProps) {
  const hasActiveFilters =
    !!filters.search || !!filters.category || !!filters.companyName || !!filters.state || filters.hasOutreach !== undefined;

  return (
    <div className="flex flex-wrap gap-3 items-center">
      {/* Search */}
      <div className="relative flex-1 min-w-[200px]">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search contacts..."
          value={filters.search ?? ""}
          onChange={(e) => onFilterChange({ search: e.target.value || undefined })}
          className="pl-9"
        />
      </div>

      {/* Category */}
      <Select
        value={filters.category ?? "all"}
        onValueChange={(v) => onFilterChange({ category: v === "all" || v == null ? undefined : v })}
      >
        <SelectTrigger className="w-[160px]">
          <SelectValue placeholder="All Categories" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Categories</SelectItem>
          {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
            <SelectItem key={key} value={key}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Outreach Status */}
      <Select
        value={filters.hasOutreach === undefined ? "all" : filters.hasOutreach ? "yes" : "no"}
        onValueChange={(v) =>
          onFilterChange({ hasOutreach: v === "all" ? undefined : v === "yes" })
        }
      >
        <SelectTrigger className="w-[160px]">
          <SelectValue placeholder="Outreach Status" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Outreach</SelectItem>
          <SelectItem value="yes">Outreach Done</SelectItem>
          <SelectItem value="no">Needs Outreach</SelectItem>
        </SelectContent>
      </Select>

      {/* Sort */}
      <Select
        value={filters.sortBy ?? "updated_at"}
        onValueChange={(v) => onFilterChange({ sortBy: v ?? undefined })}
      >
        <SelectTrigger className="w-[160px]">
          <SelectValue placeholder="Sort By" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="updated_at">Last Updated</SelectItem>
          <SelectItem value="name">Name</SelectItem>
          <SelectItem value="company_name">Company</SelectItem>
          <SelectItem value="created_at">Date Created</SelectItem>
          <SelectItem value="last_contacted_at">Last Contacted</SelectItem>
          <SelectItem value="touchpoint_count">Touchpoints</SelectItem>
        </SelectContent>
      </Select>

      {/* Reset */}
      {hasActiveFilters && (
        <Button variant="ghost" size="sm" onClick={onReset}>
          <X className="h-4 w-4 mr-1" />
          Clear
        </Button>
      )}
    </div>
  );
}
