import { cn } from "@/lib/utils";

type BrandLogoProps = {
  className?: string;
  alt?: string;
  surfaceClassName?: string;
};

export function BrandLogo({
  className,
  alt = "T Rock Construction",
  surfaceClassName,
}: BrandLogoProps) {
  return (
    <span
      data-brand-logo-surface="dark"
      className={cn(
        "inline-flex items-center justify-center rounded-xl bg-slate-950 px-3 py-2 shadow-sm",
        surfaceClassName
      )}
    >
      <img
        src="/logo.png"
        alt={alt}
        className={cn("block h-auto w-auto object-contain", className)}
      />
    </span>
  );
}
