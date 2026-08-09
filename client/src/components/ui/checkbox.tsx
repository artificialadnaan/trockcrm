import * as React from "react";

interface CheckboxProps {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
  /** Accessible name for a checkbox with no adjacent <label>, e.g. one alone in a table cell where the
   *  only context is the row. The props interface is closed (not ...rest), so before this existed an
   *  aria-label passed by a caller was silently DROPPED and the control shipped unnamed — a screen
   *  reader announced "checkbox" with no indication of which row or which setting. */
  "aria-label"?: string;
  id?: string;
}

const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ checked = false, onCheckedChange, disabled, className = "", id, "aria-label": ariaLabel }, ref) => {
    return (
      <input
        ref={ref}
        type="checkbox"
        id={id}
        aria-label={ariaLabel}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onCheckedChange?.(e.target.checked)}
        className={`h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
      />
    );
  }
);
Checkbox.displayName = "Checkbox";

export { Checkbox };
