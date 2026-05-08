import { Briefcase, Calendar, Mail, NotebookPen, Phone } from "lucide-react";
import { cn } from "@/lib/utils";

export type ActivityType = "phone" | "mail" | "calendar" | "note" | "deal";

export type ActivityTimelineItem = {
  id: string;
  type: ActivityType;
  who: string;
  what: string;
  when: string;
};

const activityIcon = {
  phone: { Icon: Phone, className: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  mail: { Icon: Mail, className: "bg-blue-50 text-blue-700 ring-blue-200" },
  calendar: { Icon: Calendar, className: "bg-violet-50 text-violet-700 ring-violet-200" },
  note: { Icon: NotebookPen, className: "bg-amber-50 text-amber-700 ring-amber-200" },
  deal: { Icon: Briefcase, className: "bg-brand-red/10 text-brand-red ring-brand-red/20" },
} satisfies Record<ActivityType, { Icon: typeof Phone; className: string }>;

export function ActivityTimeline({ items, className }: { items: ActivityTimelineItem[]; className?: string }) {
  return (
    <ol className={cn("space-y-4", className)}>
      {items.map((item, index) => {
        const { Icon, className: iconClassName } = activityIcon[item.type];
        return (
          <li key={item.id} className="relative flex items-start gap-3">
            {index < items.length - 1 ? (
              <span className="absolute left-4 top-9 -ml-px w-px bg-slate-200" style={{ bottom: "-1rem" }} aria-hidden />
            ) : null}
            <span className={cn("z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-1", iconClassName)}>
              <Icon className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1 pt-1">
              <p className="text-sm font-semibold text-slate-950">{item.what}</p>
              <p className="mt-0.5 text-xs text-slate-500">
                <span className="font-semibold">{item.who}</span> · {item.when}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
