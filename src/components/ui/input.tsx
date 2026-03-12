import * as React from "react";
import { cn } from "../../lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      "flex h-11 w-full rounded-md border border-[#e5e7eb] bg-white px-3 py-2 text-sm text-[#111827] outline-none ring-offset-white placeholder:text-[#9ca3af] focus-visible:ring-2 focus-visible:ring-[#f97316]/30 disabled:cursor-not-allowed disabled:opacity-50",
      className
    )}
    {...props}
  />
));
Input.displayName = "Input";

export { Input };
