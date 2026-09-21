"use client";

import { Button } from "@web/components/ui/button";

export default function AuthenticatedError({
  reset,
}: {
  readonly reset: () => void;
}) {
  return (
    <div className="mx-auto w-full max-w-[42rem] px-bro-pad pt-[0.6rem] pb-20">
      <h1 className="type-sec-title">Страница не открылась</h1>
      <p className="type-fine mt-[0.35rem] text-muted-foreground">
        Что-то пошло не так на нашей стороне.
      </p>
      <div className="mt-4">
        <Button onClick={reset} size="act" type="button" variant="act">
          Попробовать ещё раз
        </Button>
      </div>
    </div>
  );
}
