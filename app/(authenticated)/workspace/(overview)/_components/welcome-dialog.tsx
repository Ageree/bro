"use client";

import { Button } from "@web/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@web/components/ui/dialog";

/**
 * Covers the cabinet of an account that has not written to Bro yet: the
 * landing's «Написать bro» leads through sign-in to here, and this is where
 * Bro's chat opens — Telegram, or iMessage where Telegram is not set up.
 * «Позже» closes it for this visit only; it comes back on the next one until
 * the person's first message to Bro.
 */
export function WelcomeDialog({
  channel,
  href,
}: {
  readonly channel: string;
  readonly href: string;
}) {
  return (
    <Dialog defaultOpen>
      <DialogContent
        className="gap-0 bro-plate p-6 sm:max-w-md sm:p-8"
        showCloseButton={false}
      >
        <DialogTitle className="type-sec-title mb-2">Напиши Bro</DialogTitle>
        <DialogDescription className="type-fine">
          Bro живёт в {channel}. Начни с «привет» или сразу с дела — он
          представится и возьмётся.
        </DialogDescription>
        <div className="mt-6 flex flex-col gap-3">
          <Button
            className="w-full"
            nativeButton={false}
            render={<a aria-label={`Написать Bro в ${channel}`} href={href} />}
            variant="paper"
          >
            Написать Bro
          </Button>
          <DialogClose
            render={<Button className="w-full" size="paper" variant="ghost" />}
          >
            Позже
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}
