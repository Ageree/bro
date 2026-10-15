"use client";

import { Document } from "@web/components/paper/document";
import { Button } from "@web/components/ui/button";

export default function AuthenticatedError({
  reset,
}: {
  readonly reset: () => void;
}) {
  return (
    <Document className="pb-20">
      <section
        aria-labelledby="authenticated-error-heading"
        className="mt-6 bro-plate p-6 sm:p-8"
      >
        <h1 className="type-doc-title" id="authenticated-error-heading">
          Страница не открылась
        </h1>
        <p className="type-fine mt-[0.35rem] text-muted-foreground">
          Что-то пошло не так на нашей стороне.
        </p>
        <div className="mt-6">
          <Button onClick={reset} type="button" variant="paper">
            Попробовать ещё раз
          </Button>
        </div>
      </section>
    </Document>
  );
}
