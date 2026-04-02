import { useState, useEffect } from "react";
import { Search, X } from "lucide-react";

interface FileSearchBarProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export function FileSearchBar({
  value,
  onChange,
  placeholder = "Search files...",
}: FileSearchBarProps) {
  const [local, setLocal] = useState(value);

  // Debounce: propagate after 300ms of no typing
  useEffect(() => {
    const timer = setTimeout(() => {
      if (local !== value) onChange(local);
    }, 300);
    return () => clearTimeout(timer);
  }, [local, value, onChange]);

  // Sync from parent
  useEffect(() => {
    setLocal(value);
  }, [value]);

  return (
    <div className="relative">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
      <input
        type="text"
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        placeholder={placeholder}
        className="w-full pl-9 pr-8 py-2 text-sm border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring"
      />
      {local && (
        <button
          className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 hover:bg-accent rounded"
          onClick={() => {
            setLocal("");
            onChange("");
          }}
        >
          <X className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      )}
    </div>
  );
}
