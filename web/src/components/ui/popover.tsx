import type { ComponentProps } from "react";
import { Popover as Primitive } from "radix-ui";
import { cn } from "@/lib/utils";

export const Popover = Primitive.Root;
export const PopoverTrigger = Primitive.Trigger;
export const PopoverAnchor = Primitive.Anchor;

export function PopoverContent({
  className,
  sideOffset = 8,
  portalContainer,
  ...props
}: ComponentProps<typeof Primitive.Content> & {
  portalContainer?: HTMLElement;
}) {
  return (
    <Primitive.Portal container={portalContainer}>
      <Primitive.Content
        sideOffset={sideOffset}
        collisionPadding={12}
        className={cn(
          "floating-surface z-50 text-popover-foreground outline-none",
          className,
        )}
        {...props}
      />
    </Primitive.Portal>
  );
}
