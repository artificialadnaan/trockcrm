const consoleSections = [
  { id: "manager-brief", label: "Manager brief" },
  { id: "queue-health", label: "Queue health" },
  { id: "manager-alerts", label: "Manager alerts" },
  { id: "outcome-effectiveness", label: "Outcome effectiveness" },
  { id: "policy-recommendations", label: "Policy recommendations" },
] as const;

export function InterventionManagerConsoleNav() {
  return (
    <nav aria-label="Manager console sections" className="flex flex-wrap gap-2">
      {consoleSections.map((section) => (
        <a
          key={section.id}
          href={`#${section.id}`}
          className="inline-flex items-center rounded-full border border-border bg-white px-3 py-1.5 text-xs font-semibold uppercase tracking-widest text-gray-700 transition-colors hover:border-brand-red/40 hover:text-gray-900"
        >
          {section.label}
        </a>
      ))}
    </nav>
  );
}
