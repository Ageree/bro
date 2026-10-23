"use client";

import { ChevronRightIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { type SubmitEvent, useState } from "react";
import type { listBroLinks } from "@db/services/bro-to-bro/links";
import { Badge } from "@web/components/ui/badge";
import { Button } from "@web/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@web/components/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@web/components/ui/field";
import { Input } from "@web/components/ui/input";
import { Switch } from "@web/components/ui/switch";
import { Textarea } from "@web/components/ui/textarea";
import { api } from "@web/trpc/client";
import { broFailure } from "./failure";

type BroLink = Awaited<ReturnType<typeof listBroLinks>>[number];

const shareNotesMax = 2000;
const labelMax = 200;

/** Where the link stands, from this person's side. */
function linkStatus(link: BroLink) {
  if (link.status === "active") return "активна";
  if (link.awaitingMyConfirmation) return "ждёт твоего подтверждения";
  return link.peerName
    ? `ждёт, когда ${link.peerName} подтвердит`
    : "ждёт подтверждения";
}

/**
 * One link in the cabinet: who it is with and where it stands, and its card,
 * opened from the row, with what this person opens to the peer.
 */
export function BroLinkRow({ link }: { readonly link: BroLink }) {
  const [open, setOpen] = useState(false);
  const name = link.peerName ?? "Без имени";

  return (
    <li className="border-t border-border first:border-t-0">
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogTrigger
          render={
            <Button
              className="flex w-full items-baseline justify-between gap-4 py-3"
              size="none"
              type="button"
              variant="act"
            />
          }
        >
          <span className="type-row min-w-0 flex-1">
            {name}
            {link.peerTelegramUsername ? (
              <span className="text-muted-foreground">
                {" "}
                @{link.peerTelegramUsername}
              </span>
            ) : null}
            {link.label ? (
              <span className="type-status block text-muted-foreground">
                Для тебя — «{link.label}»
              </span>
            ) : null}
          </span>
          <span className="type-status flex shrink-0 items-center gap-1 text-muted-foreground">
            {link.awaitingMyConfirmation ? (
              <Badge variant="outline">{linkStatus(link)}</Badge>
            ) : (
              linkStatus(link)
            )}
            <ChevronRightIcon aria-hidden="true" className="size-4" />
          </span>
        </DialogTrigger>
        <DialogContent
          animated={false}
          className="no-scrollbar overflow-y-auto"
          variant="responsive"
        >
          <DialogHeader className="pr-10 sm:pr-6">
            <DialogTitle className="type-sheet-title">{name}</DialogTitle>
            <DialogDescription className="type-fine">
              {[
                link.peerTelegramUsername
                  ? `@${link.peerTelegramUsername}`
                  : null,
                `связь ${linkStatus(link)}`,
              ]
                .filter((part) => part !== null)
                .join(" · ")}
            </DialogDescription>
          </DialogHeader>
          {link.awaitingMyConfirmation ? (
            <ConfirmLink link={link} name={name} />
          ) : link.status === "pending" ? (
            <p className="type-fine text-muted-foreground">
              Пока связь не подтверждена, Бро ничего друг другу не передают.
            </p>
          ) : null}
          <FieldGroup>
            <CalendarRight link={link} />
            <ShareNotes key={link.shareNotes ?? ""} link={link} />
            <PeerLabel key={link.label ?? ""} link={link} />
          </FieldGroup>
          <RemoveLink
            link={link}
            onRemoved={() => {
              setOpen(false);
            }}
          />
        </DialogContent>
      </Dialog>
    </li>
  );
}

/**
 * The inviter checks that whoever accepted is the person they invited:
 * until then the two Bros pass nothing.
 */
function ConfirmLink({
  link,
  name,
}: {
  readonly link: BroLink;
  readonly name: string;
}) {
  const router = useRouter();
  const confirm = api.broToBro.confirm.useMutation({
    onSuccess: () => {
      router.refresh();
    },
  });

  return (
    <div className="rounded-3xl border-2 border-foreground p-4">
      <p className="type-row">
        Приглашение принято: {name}
        {link.peerTelegramUsername ? ` (@${link.peerTelegramUsername})` : ""}.
        Это тот, кого ты приглашаешь?
      </p>
      <p className="type-fine text-muted-foreground">
        Пока не подтвердишь, Бро ничего друг другу не передают. Если это кто-то
        другой — разорви связь внизу.
      </p>
      {confirm.error ? (
        <p className="type-status text-destructive" role="alert">
          {broFailure(confirm.error)}
        </p>
      ) : null}
      <Button
        className="mt-3"
        disabled={confirm.isPending}
        onClick={() => {
          confirm.mutate({ linkId: link.id });
        }}
        type="button"
        variant="paper"
      >
        Подтвердить связь
      </Button>
    </div>
  );
}

function CalendarRight({ link }: { readonly link: BroLink }) {
  const router = useRouter();
  const set = api.broToBro.setCalendar.useMutation({
    onSuccess: () => {
      router.refresh();
    },
  });
  const id = `bro-calendar-${link.id}`;

  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor={id}>
          Время по календарю — без названий событий
        </FieldLabel>
        <FieldDescription className="type-fine">
          Бро сам предлагает и принимает время по свободным окнам твоего
          календаря. Собеседнику уходят только варианты — без названий и причин
          занятости. Выключишь — о времени Бро сначала спросит тебя.
          {link.peerCalendar
            ? " Собеседник своё время тоже открыл."
            : " Собеседник своё время не открыл."}
        </FieldDescription>
        {set.error ? (
          <FieldError className="type-fine">{broFailure(set.error)}</FieldError>
        ) : null}
      </FieldContent>
      <Switch
        checked={set.isPending ? set.variables.allowed : link.calendar}
        disabled={set.isPending}
        id={id}
        onCheckedChange={(allowed) => {
          set.mutate({ allowed, linkId: link.id });
        }}
      />
    </Field>
  );
}

/** What this person's Bro may tell the peer without asking. */
function ShareNotes({ link }: { readonly link: BroLink }) {
  const router = useRouter();
  const [notes, setNotes] = useState(link.shareNotes ?? "");
  const save = api.broToBro.setShareNotes.useMutation({
    onSuccess: () => {
      router.refresh();
    },
  });
  const id = `bro-notes-${link.id}`;
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    save.mutate({ linkId: link.id, notes });
  };

  return (
    <form noValidate onSubmit={submit}>
      <Field>
        <FieldLabel
          className="type-field-label text-muted-foreground"
          htmlFor={id}
        >
          Что можно рассказывать
        </FieldLabel>
        <Textarea
          id={id}
          maxLength={shareNotesMax}
          onChange={(event) => {
            setNotes(event.target.value);
          }}
          placeholder="Например: по будням работаю до семи, по субботам на даче"
          value={notes}
        />
        <FieldDescription className="type-fine">
          Это Бро может рассказать собеседнику без спроса. Остальное — только
          после твоего «да» на точный текст.
        </FieldDescription>
        {save.error ? (
          <FieldError className="type-fine">
            {broFailure(save.error)}
          </FieldError>
        ) : null}
      </Field>
      <div className="mt-2 flex items-baseline justify-between gap-4">
        <span className="type-status text-muted-foreground">
          {notes.length} из {shareNotesMax}
        </span>
        <Button
          disabled={save.isPending || notes.trim() === (link.shareNotes ?? "")}
          type="submit"
          variant="outline"
        >
          Сохранить
        </Button>
      </div>
    </form>
  );
}

/** How this person calls the peer: theirs and their own Bro's alone. */
function PeerLabel({ link }: { readonly link: BroLink }) {
  const router = useRouter();
  const [label, setLabel] = useState(link.label ?? "");
  const save = api.broToBro.setLabel.useMutation({
    onSuccess: () => {
      router.refresh();
    },
  });
  const id = `bro-label-${link.id}`;
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    save.mutate({ label, linkId: link.id });
  };

  return (
    <form noValidate onSubmit={submit}>
      <Field>
        <FieldLabel
          className="type-field-label text-muted-foreground"
          htmlFor={id}
        >
          Как ты называешь собеседника — видишь только ты
        </FieldLabel>
        <div className="flex items-center gap-3">
          <Input
            id={id}
            maxLength={labelMax}
            onChange={(event) => {
              setLabel(event.target.value);
            }}
            placeholder="брат, Петя с работы"
            value={label}
            variant="paper"
          />
          <Button
            disabled={save.isPending || label.trim() === (link.label ?? "")}
            type="submit"
            variant="outline"
          >
            Сохранить
          </Button>
        </div>
        <FieldDescription className="type-fine">
          По подписи твой Бро понимает, о ком ты. Собеседнику она не уходит.
        </FieldDescription>
        {save.error ? (
          <FieldError className="type-fine">
            {broFailure(save.error)}
          </FieldError>
        ) : null}
      </Field>
    </form>
  );
}

/**
 * Removes the link for both people once the person confirms, and says
 * honestly what removal cannot undo.
 */
function RemoveLink({
  link,
  onRemoved,
}: {
  readonly link: BroLink;
  readonly onRemoved: () => void;
}) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const remove = api.broToBro.remove.useMutation({
    onSuccess: () => {
      onRemoved();
      router.refresh();
    },
  });

  if (!asking) {
    return (
      <Button
        className="justify-self-start text-destructive"
        onClick={() => {
          setAsking(true);
        }}
        size="act-sm"
        type="button"
        variant="act"
      >
        Разорвать связь
      </Button>
    );
  }

  return (
    <fieldset className="rounded-3xl border-2 border-destructive-border p-4">
      <legend className="type-row float-left w-full">Разорвать связь?</legend>
      <p className="type-fine clear-both text-muted-foreground">
        Связь пропадёт у обоих, открытые переговоры закроются, а неотправленное
        не уйдёт. Уже сказанное Бро собеседника не отзывается.
      </p>
      {remove.error ? (
        <p className="type-status text-destructive" role="alert">
          {broFailure(remove.error)}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-3">
        <Button
          disabled={remove.isPending}
          onClick={() => {
            remove.mutate({ linkId: link.id });
          }}
          type="button"
          variant="destructive"
        >
          Разорвать
        </Button>
        <Button
          disabled={remove.isPending}
          onClick={() => {
            setAsking(false);
          }}
          type="button"
          variant="outline"
        >
          Оставить
        </Button>
      </div>
    </fieldset>
  );
}
