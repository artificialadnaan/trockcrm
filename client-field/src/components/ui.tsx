import React from "react";
import { cn } from "@/lib/utils";

export function Button({
  className,
  variant = "primary",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" }) {
  return (
    <button
      className={cn(
        "inline-flex min-h-11 items-center justify-center rounded-md px-4 py-2 font-semibold transition disabled:cursor-not-allowed disabled:opacity-60",
        variant === "primary" && "bg-primary text-primary-foreground shadow-sm hover:brightness-95",
        variant === "ghost" && "bg-transparent text-foreground hover:bg-muted",
        variant === "danger" && "bg-destructive text-destructive-foreground",
        className
      )}
      {...props}
    />
  );
}

export function TextInput({
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "min-h-12 w-full rounded-md border border-border bg-white px-3 text-base outline-none ring-primary/25 transition focus:ring-4",
        className
      )}
      {...props}
    />
  );
}
