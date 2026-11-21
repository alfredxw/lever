import * as React from "react";
import { cn } from "cn";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-lg border border-input bg-(--control-background) px-2.5 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-foreground/35 focus-visible:bg-control-hover disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive md:text-[length:var(--text-control)] dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
