import { Separator as SeparatorPrimitive } from "@base-ui/react/separator"

import { cn } from "@/lib/utils"

function Separator({
  className,
  orientation = "horizontal",
  ...props
}: SeparatorPrimitive.Props) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation}
      className={cn(
        // Base UI renders `data-orientation="horizontal"|"vertical"` — a VALUE, not the bare
        // `data-horizontal`/`data-vertical` attributes the upstream classes targeted. Those selectors matched
        // nothing, and since these four classes are the separator's ONLY sizing, every separator in the app
        // rendered at zero height/width. Converting the v4 variant syntax alone did not fix it: the syntax
        // became valid while still pointing at an attribute that does not exist.
        "shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:w-px data-[orientation=vertical]:self-stretch",
        className
      )}
      {...props}
    />
  )
}

export { Separator }
