import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface SalesReviewFiltersProps {
  from: string;
  to: string;
  forecastWindow: string;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
  onForecastWindowChange: (value: string) => void;
}

export function SalesReviewFilters({
  from,
  to,
  forecastWindow,
  onFromChange,
  onToChange,
  onForecastWindowChange,
}: SalesReviewFiltersProps) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">From</label>
        <Input type="date" value={from} onChange={(event) => onFromChange(event.target.value)} className="w-[160px]" />
      </div>
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">To</label>
        <Input type="date" value={to} onChange={(event) => onToChange(event.target.value)} className="w-[160px]" />
      </div>
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">Forecast Window</label>
        <Select value={forecastWindow} onValueChange={(value) => onForecastWindowChange(value ?? "all")}>
          <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Windows</SelectItem>
            <SelectItem value="30_days">30 Days</SelectItem>
            <SelectItem value="60_days">60 Days</SelectItem>
            <SelectItem value="90_days">90 Days</SelectItem>
            <SelectItem value="beyond_90">Beyond 90</SelectItem>
            <SelectItem value="uncommitted">Uncommitted</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
