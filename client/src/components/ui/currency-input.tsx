import { Input } from "@/components/ui/input";

interface CurrencyInputProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  /** Named for a control with no adjacent <label> — e.g. the two free-text "Other" cost rows. */
  "aria-label"?: string;
  /**
   * Declared, not spread. This props interface is CLOSED — there is no `...rest` — so an attribute a
   * caller passes that is not named here is silently dropped, which is exactly how `Checkbox` shipped
   * without the aria-labels its callers thought they were passing.
   */
  "data-testid"?: string;
  placeholder?: string;
  disabled?: boolean;
}

/**
 * A dollar-amount box: a `$` adornment over a numeric input.
 *
 * Promoted out of `components/leads/`, where three separate copies of the same twenty lines had
 * accumulated (lead-form, lead-questionnaire-editor, lead-questionnaire-sections). The marketing expense
 * form needs eight of them, which would have made a fourth copy.
 *
 * The value is a STRING all the way through and is never parsed here. Money is `numeric(14,2)` on the
 * server, it round-trips as a string, and there is no decimal library in this repo — so the moment this
 * component "helpfully" returned a number, `0.1 + 0.2` would start costing $0.30000000000000004. Shape
 * validation lives in `parseMoneyInput` (shared), and the authoritative total is summed in SQL.
 */
export function CurrencyInput({
  id,
  value,
  onChange,
  "aria-label": ariaLabel,
  "data-testid": testId,
  placeholder = "0.00",
  disabled,
}: CurrencyInputProps) {
  return (
    <div className="relative">
      <span
        aria-hidden
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground"
      >
        $
      </span>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        min="0"
        step="0.01"
        aria-label={ariaLabel}
        data-testid={testId}
        placeholder={placeholder}
        disabled={disabled}
        className="pl-7"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
