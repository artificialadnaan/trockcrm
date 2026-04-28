import { Input } from "@/components/ui/input";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface DateFieldProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  min?: string;
  max?: string;
  className?: string;
  required?: boolean;
}

/**
 * Native date picker wrapper. Accepts a YYYY-MM-DD string or empty; any
 * non-conforming legacy value (e.g. "Q1 2026") is treated as empty so the
 * picker renders blank instead of crashing — the surrounding form is
 * responsible for surfacing legacy text to the user separately.
 */
export function DateField({
  id,
  value,
  onChange,
  disabled,
  min,
  max,
  className,
  required,
}: DateFieldProps) {
  const safeValue = ISO_DATE.test(value) ? value : "";
  return (
    <Input
      id={id}
      type="date"
      value={safeValue}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
      min={min}
      max={max}
      className={className}
      required={required}
    />
  );
}
