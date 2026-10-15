import * as React from "react";
import { Input as InputPrimitive } from "@base-ui/react/input";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@web/components/class-names";

const inputVariants = cva(
  "type-input h-10 w-full min-w-0 rounded-full border-2 border-input bg-card px-4 py-1 transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:type-label file:text-foreground placeholder:text-muted-foreground focus-visible:border-foreground focus-visible:ring-0 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive",
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
        // bro: a field on a plate is a pill with an ink border.
        paper:
          "h-auto border-foreground bg-card px-4 py-2.5 type-row text-foreground focus-visible:border-foreground focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-foreground read-only:border-border read-only:text-muted-foreground aria-invalid:border-destructive aria-invalid:ring-0",
      },
      size: {
        default: null,
        lg: "h-11 px-4",
        xl: "h-12 px-5",
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
