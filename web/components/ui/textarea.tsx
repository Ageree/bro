import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@web/components/class-names";

const textareaVariants = cva(
  "type-input flex field-sizing-content min-h-16 w-full rounded-2xl border-2 border-input bg-card px-4 py-3 transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-foreground focus-visible:ring-0 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: null,
        "input-group":
          "flex-1 resize-none rounded-none border-0 bg-transparent shadow-none ring-0 focus-visible:ring-0 disabled:bg-transparent aria-invalid:ring-0 dark:bg-transparent dark:disabled:bg-transparent",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

function Textarea({
  className,
  variant,
  ...props
}: React.ComponentProps<"textarea"> & VariantProps<typeof textareaVariants>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(textareaVariants({ variant, className }))}
      {...props}
    />
  );
}

export { Textarea, textareaVariants };
