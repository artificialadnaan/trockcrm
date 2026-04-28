import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ACTIVITY_RANGES,
  ACTIVITY_RANGE_LABELS,
  type ActivityRange,
} from "@trock-crm/shared/types";

interface ActivityRangeSelectProps {
  value: ActivityRange;
  onChange: (range: ActivityRange) => void;
  className?: string;
}

export function ActivityRangeSelect({ value, onChange, className }: ActivityRangeSelectProps) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as ActivityRange)}>
      <SelectTrigger className={className} aria-label="Activity range">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ACTIVITY_RANGES.map((range) => (
          <SelectItem key={range} value={range}>
            {ACTIVITY_RANGE_LABELS[range]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
