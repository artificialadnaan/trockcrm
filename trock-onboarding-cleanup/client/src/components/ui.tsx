import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/utils";

export function Button({
  className,
  variant = "primary",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" }) {
  const variants = {
    primary: "bg-red-700 text-stone-50 hover:bg-red-800 disabled:bg-stone-300 disabled:text-stone-500",
    secondary: "border border-stone-300 bg-stone-50 text-stone-950 hover:bg-stone-100 disabled:text-stone-400",
    ghost: "text-stone-700 hover:bg-stone-100 disabled:text-stone-400",
    danger: "bg-stone-950 text-stone-50 hover:bg-stone-800 disabled:bg-stone-300",
  };
  return (
    <button
      className={cn(
        "inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2 disabled:cursor-not-allowed",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}

export function Panel({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <section className={cn("rounded-md border border-stone-200 bg-stone-50 shadow-sm", className)} {...props} />;
}

export function Badge({ className, tone = "neutral", children }: { className?: string; tone?: "neutral" | "red" | "amber" | "green"; children: ReactNode }) {
  const tones = {
    neutral: "border-stone-300 bg-stone-100 text-stone-700",
    red: "border-red-200 bg-red-50 text-red-800",
    amber: "border-amber-200 bg-amber-50 text-amber-900",
    green: "border-emerald-200 bg-emerald-50 text-emerald-800",
  };
  return <span className={cn("inline-flex items-center rounded px-2 py-1 text-xs font-medium", tones[tone], className)}>{children}</span>;
}

export function FieldLabel({ children }: { children: ReactNode }) {
  return <label className="text-sm font-semibold text-stone-800">{children}</label>;
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn("min-h-11 w-full rounded-md border border-stone-300 bg-stone-50 px-3 text-sm text-stone-950 outline-none focus:border-red-700 focus:ring-2 focus:ring-red-100", props.className)} />;
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cn("min-h-28 w-full rounded-md border border-stone-300 bg-stone-50 px-3 py-2 text-sm text-stone-950 outline-none focus:border-red-700 focus:ring-2 focus:ring-red-100", props.className)} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cn("min-h-11 w-full rounded-md border border-stone-300 bg-stone-50 px-3 text-sm text-stone-950 outline-none focus:border-red-700 focus:ring-2 focus:ring-red-100", props.className)} />;
}
