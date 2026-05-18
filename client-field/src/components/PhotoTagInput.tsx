import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { api } from "../lib/api";

type PhotoTagInputProps = {
  projectId?: string;
  disabled?: boolean;
  value: string[];
  onChange: (tags: string[]) => void;
};

function normalizeTag(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

export function PhotoTagInput({ projectId, disabled, value, onChange }: PhotoTagInputProps) {
  const [draft, setDraft] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);

  useEffect(() => {
    if (!projectId || !draft.trim()) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api<{ tags: string[] }>(`/field/projects/${projectId}/tags?q=${encodeURIComponent(draft)}&limit=8`)
        .then((result) => {
          if (!cancelled) setSuggestions(result.tags.filter((tag) => !value.some((current) => current.toLowerCase() === tag.toLowerCase())));
        })
        .catch(() => {
          if (!cancelled) setSuggestions([]);
        });
    }, 150);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [draft, projectId, value]);

  function commitTag(raw: string) {
    const tag = normalizeTag(raw);
    if (!tag) return;
    if (value.some((current) => current.toLowerCase() === tag.toLowerCase())) {
      setDraft("");
      return;
    }
    onChange([...value, tag]);
    setDraft("");
    setSuggestions([]);
  }

  function removeTag(tag: string) {
    onChange(value.filter((current) => current.toLowerCase() !== tag.toLowerCase()));
  }

  return (
    <div className="space-y-2">
      <label className="block text-xs font-black uppercase tracking-[0.14em] text-white/70">Tags</label>
      <div className="flex flex-wrap gap-2">
        {value.map((tag) => (
          <span key={tag} className="inline-flex items-center gap-1 rounded-full bg-red-600 px-3 py-1 text-xs font-bold text-white">
            {tag}
            <button type="button" aria-label={`Remove tag ${tag}`} disabled={disabled} onClick={() => removeTag(tag)}>
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>
      <input
        aria-label="Photo tags"
        className="min-h-11 w-full rounded-md border border-white/10 bg-white px-3 text-sm text-slate-950 outline-none ring-primary/25 focus:ring-4"
        placeholder="Type a tag and press Enter"
        value={draft}
        disabled={disabled}
        onInput={(event) => setDraft((event.target as HTMLInputElement).value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === ",") {
            event.preventDefault();
            commitTag(draft);
          }
        }}
      />
      {suggestions.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {suggestions.map((tag) => (
            <button
              key={tag}
              type="button"
              className="rounded-full bg-white/15 px-3 py-1 text-xs font-bold text-white"
              onClick={() => commitTag(tag)}
            >
              {tag}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
