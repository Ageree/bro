import * as React from "react";
import { Input as InputPrimitive } from "@base-ui/react/input";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@web/components/class-names";

const inputVariants = cva(
  "type-input h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:type-label file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
  {
    variants: {
      variant: {
        default: null,
        plain:
          "h-auto rounded-none border-0 bg-transparent p-0 shadow-none ring-0 focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:outline-none dark:bg-transparent",
        currency:
          "h-fit rounded-none border-0 bg-transparent p-0 shadow-none ring-0 focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:outline-none dark:bg-transparent",
        "input-group":
          "flex-1 rounded-none border-0 bg-transparent shadow-none ring-0 focus-visible:ring-0 disabled:bg-transparent aria-invalid:ring-0 dark:bg-transparent dark:disabled:bg-transparent",
        // bro: a field on paper is a hairline rectangle, square-cornered.
        paper:
          "h-auto rounded-none border-foreground bg-background px-[0.7rem] py-[0.6rem] type-row text-foreground focus-visible:border-foreground focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-foreground read-only:border-border read-only:text-muted-foreground aria-invalid:border-destructive aria-invalid:ring-0 dark:bg-background",
      },
      size: {
        default: null,
        lg: "h-10 px-3",
        xl: "h-12 px-3.5",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

function Input({
  className,
  type,
  variant,
  size = "default",
  ...props
}: Omit<React.ComponentProps<"input">, "size"> &
  VariantProps<typeof inputVariants>) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      data-size={size}
      className={cn(inputVariants({ className, size, variant }))}
      {...props}
    />
  );
}

export { Input, inputVariants };
