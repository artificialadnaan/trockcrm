import { cn } from "@/lib/utils";

type BrandLogoProps = {
  className?: string;
  alt?: string;
};

export function BrandLogo({
  className,
  alt = "T Rock Construction",
}: BrandLogoProps) {
  return (
    <img
      src="/logo.png"
      alt={alt}
      className={cn("block h-auto w-auto object-contain", className)}
    />
  );
}
