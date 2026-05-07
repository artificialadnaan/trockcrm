import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export const EYEBROW = "text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500";

export function Eyebrow({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn(EYEBROW, className)} {...props} />;
}
