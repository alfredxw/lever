import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { Slot } from "radix-ui";

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-[length:var(--text-control)] font-medium whitespace-nowrap transition-[background-color,border-color,color,opacity] duration-150 motion-reduce:transition-none outline-none select-none disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:bg-primary/75 active:bg-primary/80",
        outline:
          "border-border bg-(--control-background) hover:bg-control-hover focus-visible:bg-control-focus aria-expanded:bg-control-selected aria-expanded:focus-visible:bg-control-focus active:bg-control-selected dark:border-input",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-control-hover focus-visible:bg-control-focus aria-expanded:bg-control-selected aria-expanded:focus-visible:bg-control-focus active:bg-control-selected",
        ghost:
          "hover:bg-control-hover hover:text-foreground focus-visible:bg-control-focus focus-visible:text-foreground aria-expanded:bg-control-selected aria-expanded:focus-visible:bg-control-focus aria-expanded:text-foreground active:bg-control-selected",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:bg-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:bg-destructive/30",
        link: "text-primary underline-offset-4 hover:underline focus-visible:bg-control-focus focus-visible:underline",
      },
      size: {
        default:
          "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-md px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-md px-2.5 in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-8",
        "icon-xs":
          "size-6 rounded-md in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7 rounded-md in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
