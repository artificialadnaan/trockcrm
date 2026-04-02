import { Button } from "@/components/ui/button";
import type { DateRangePreset } from "@/hooks/use-director-dashboard";

interface DateRangeToggleProps {
  value: DateRangePreset;
  onChange: (preset: DateRangePreset) => void;
}

const PRESETS: Array<{ value: DateRangePreset; label: string }> = [
  { value: "mtd", label: "MTD" },
  { value: "qtd", label: "QTD" },
  { value: "ytd", label: "YTD" },
  { value: "last_month", label: "Last Month" },
  { value: "last_quarter", label: "Last Quarter" },
  { value: "last_year", label: "Last Year" },
];

export function DateRangeToggle({ value, onChange }: DateRangeToggleProps) {
  return (
    <div className="flex gap-1 flex-wrap">
      {PRESETS.map((preset) => (
        <Button
          key={preset.value}
          variant={value === preset.value ? "default" : "outline"}
          size="sm"
          onClick={() => onChange(preset.value)}
          className="text-xs"
        >
          {preset.label}
        </Button>
      ))}
    </div>
  );
}
