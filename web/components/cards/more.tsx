"use client";

import { XIcon } from "lucide-react";
import {
  type RefObject,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { Card } from "@shared/cards/schema";
import { Button, buttonVariants } from "@web/components/ui/button";
import { CardLink } from "./card-link";
import { Carousel } from "./carousel";
import { Lightbox } from "./lightbox";
import { PhotoFrame } from "./photo-frame";
import { holdScreen } from "./telegram";
import { holdBack } from "./telegram";
import { useCardAnswer } from "./answer";

type Option = Extract<
  Card["blocks"][number],
  { type: "choice" }
>["options"][number];
type More = NonNullable<Option["more"]>;
type Photo = NonNullable<Option["photo"]>;
type Selection = Pick<
  Extract<Card["blocks"][number], { type: "choice" }>,
  "id" | "multiple"
> &
  Pick<Option, "value">;

/** What a row or an option shows of itself behind «Подробнее». */
interface Item {
  /** Its page when `more` names none: a list row's own link. */
  readonly href?: string | undefined;
  readonly more: More;
  /** The line under its title: an option's detail, a row's subtitle. */
  readonly note?: string | undefined;
  readonly photo?: Photo | undefined;
  readonly side?: string | undefined;
  readonly title: string;
}

/**
 * A row's or an option's «Подробнее» (`docs/cards.md`, «Фото в карточках»):
 * a small button under it that opens a panel from the bottom of the screen
 * with its photos, its facts, a few lines about it and its page on its site.
 * The panel is the page's own modal `<dialog>`, as the photo viewer is: the
 * card under it is inert and keeps what the person chose, focus starts in the
 * panel and goes back to the button, and Escape, the cross or a tap on the
 * dimmed card above it closes it. A photo opens on the full screen over it.
 */
export function MoreButton({
  item,
  selection,
}: {
  readonly item: Item;
  readonly selection?: Selection;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    setOpen(false);
  }, []);
  return (
    <>
      <Button
        aria-haspopup="dialog"
        aria-label={`Подробнее: ${item.title}`}
        className="self-start"
        onClick={() => {
          setOpen(true);
        }}
        ref={trigger}
        size="sm"
        type="button"
        variant="outline"
      >
        Подробнее
      </Button>
      <MorePanel
        selection={selection}
        item={item}
        onClose={close}
        open={open}
        trigger={trigger}
      />
    </>
  );
}

/**
 * The panel itself. Focus goes back to the button that opened it, named by
 * `trigger`: a tap on iOS does not focus a button, so the element in focus
 * when it opened may be the page.
 */
function MorePanel({
  item,
  onClose,
  open,
  trigger,
  selection,
}: {
  readonly item: Item;
  readonly onClose: () => void;
  readonly open: boolean;
  readonly trigger: RefObject<HTMLButtonElement | null>;
  readonly selection?: Selection;
}) {
  const answer = useCardAnswer();
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [opened, setOpened] = useState<number>();
  const closePhoto = useCallback(() => {
    setOpened(undefined);
  }, []);
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const photos = [
    ...(item.photo ? [item.photo] : []),
    ...(item.more.photos ?? []),
  ]
    .filter(
      (photo, at, all) => all.findIndex((each) => each.url === photo.url) === at
    )
    .filter((photo) => !failed.has(photo.url));
  const href = item.more.href ?? item.href;

  useLayoutEffect(() => {
    const node = dialog.current;
    if (!open || !node) return undefined;
    const opener = trigger.current;
    const release = holdScreen();
    const releaseBack = holdBack(onClose);
    node.showModal();
    node.querySelector<HTMLElement>("h2")?.focus();
    return () => {
      node.close();
      release();
      releaseBack();
      opener?.focus();
    };
  }, [open, trigger, onClose]);

  return (
    <dialog
      aria-labelledby={titleId}
      className="m-0 size-full max-h-none max-w-none bg-transparent p-0 text-foreground backdrop:bg-foreground/40"
      onClose={() => {
        if (open) onClose();
      }}
      ref={dialog}
    >
      {open && (
        <div className="flex h-dvh flex-col">
          <button
            aria-label="Закрыть"
            className="min-h-12 flex-1 cursor-default"
            onClick={onClose}
            tabIndex={-1}
            type="button"
          />
          <div className="mx-auto flex max-h-[88dvh] w-full max-w-[30rem] flex-col overflow-hidden rounded-t-[24px] border-2 border-b-0 border-foreground bg-card">
            <div className="flex items-start justify-between gap-3 p-6 pb-4">
              <div className="flex min-w-0 flex-col gap-1">
                <h2
                  className="type-cards-question wrap-anywhere outline-none"
                  id={titleId}
                  tabIndex={-1}
                >
                  {item.title}
                </h2>
                {item.side && (
                  <p className="type-row wrap-anywhere">
                    <span className="font-[600]">{item.side}</span>
                  </p>
                )}
                {item.note && (
                  <p className="type-caption wrap-anywhere text-muted-foreground">
                    {item.note}
                  </p>
                )}
              </div>
              <Button
                aria-label="Закрыть"
                onClick={onClose}
                size="icon-sm"
                type="button"
                variant="outline"
              >
                <XIcon />
              </Button>
            </div>
            <div className="flex min-h-0 flex-col gap-4 overflow-y-auto overscroll-contain px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
              {photos.length > 0 && (
                <Carousel
                  counter={photos.length > 1}
                  label={`Фото: ${item.title}`}
                  slideClassName="w-[calc(100%-1.5rem)]"
                >
                  {photos.map((photo, position) => (
                    <button
                      aria-haspopup="dialog"
                      className="w-full cursor-zoom-in overflow-hidden rounded-lg outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
                      key={photo.url}
                      onClick={() => {
                        setOpened(position);
                      }}
                      type="button"
                    >
                      <PhotoFrame
                        eager={position === 0}
                        onFailure={() => {
                          setFailed((before) => new Set(before).add(photo.url));
                        }}
                        photo={photo}
                      />
                    </button>
                  ))}
                </Carousel>
              )}
              {item.more.facts && (
                <dl className="flex flex-col">
                  {item.more.facts.map((fact) => (
                    <div
                      className="flex items-baseline justify-between gap-4 border-t border-bro-line py-3 first:border-t-0 first:pt-0 last:pb-0"
                      key={fact.label}
                    >
                      <dt className="type-row max-w-[45%] shrink-0 wrap-anywhere text-muted-foreground">
                        {fact.label}
                      </dt>
                      <dd className="type-row min-w-0 text-right wrap-anywhere">
                        {fact.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              {item.more.text && (
                <p className="type-body wrap-anywhere whitespace-pre-line">
                  {item.more.text}
                </p>
              )}
              {href && (
                <CardLink
                  className={buttonVariants({
                    className: "w-full",
                    size: "paper",
                    variant: "paper",
                  })}
                  href={href}
                >
                  Открыть на сайте
                </CardLink>
              )}
              {selection && (
                <Button
                  size="paper"
                  disabled={
                    answer.viewer !== "open" || answer.sending !== undefined
                  }
                  onClick={() => {
                    const current = [answer.draft[selection.id] ?? []].flat();
                    answer.touch(selection.id);
                    answer.set(
                      selection.id,
                      selection.multiple
                        ? [...new Set([...current, selection.value])]
                        : selection.value
                    );
                    onClose();
                  }}
                >
                  {[answer.draft[selection.id] ?? []]
                    .flat()
                    .includes(selection.value)
                    ? "Выбрано"
                    : "Выбрать"}
                </Button>
              )}
            </div>
          </div>
          <Lightbox index={opened} onClose={closePhoto} photos={photos} />
        </div>
      )}
    </dialog>
  );
}
