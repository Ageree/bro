"use client";

import { useRouter } from "next/navigation";
import { type SubmitEvent, useState } from "react";
import type { listCurrentMemories } from "@db/services/memory/records";
import { memoryTextSchema } from "@shared/memory/schema";
import { Button } from "@web/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@web/components/ui/dialog";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@web/components/ui/field";
import { Textarea } from "@web/components/ui/textarea";
import { api } from "@web/trpc/client";
import { historyLine, historyText } from "./history";

type MemoryRecord = Awaited<ReturnType<typeof listCurrentMemories>>[number];

/**
 * One memory with what the person may do to it: correct it, read and bring
 * back its history, forget it. A rule is read and forgotten only: it is set
 * and changed in a conversation with Bro.
 */
export function MemoryRecordRow({
  record,
  scopeKey,
  timeZone,
}: {
  readonly record: MemoryRecord;
  readonly scopeKey: string;
  readonly timeZone: string;
}) {
  const router = useRouter();
  const remove = api.memory.remove.useMutation({
    onSuccess: () => {
      router.refresh();
    },
  });
  const text = record.content?.text ?? "";
  const rule = record.content?.category === "rule";
  const validUntil = record.content?.validUntil;

  return (
    <li className="flex min-w-0 flex-col gap-2 border-t border-border py-[0.6rem] first:border-t-0 first:pt-[0.2rem] sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
      <div className="type-row min-w-0 flex-1 wrap-break-word">
        <p>{text}</p>
        {validUntil ? (
          <p className="type-status text-muted-foreground">
            до{" "}
            {new Intl.DateTimeFormat("ru-RU", {
              day: "2-digit",
              month: "2-digit",
              timeZone,
            }).format(new Date(validUntil))}
          </p>
        ) : null}
        {remove.error ? (
          <p className="type-status text-destructive" role="alert">
            Не удалилось: открой страницу заново.
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-baseline gap-x-4 gap-y-1">
        {rule ? null : <EditMemory record={record} scopeKey={scopeKey} />}
        <MemoryHistory
          record={record}
          scopeKey={scopeKey}
          timeZone={timeZone}
        />
        <Button
          aria-label={`Удалить: ${text}`}
          disabled={remove.isPending}
          onClick={() => {
            remove.mutate({
              expectedRevision: record.revision,
              index: record.index,
              scopeKey,
            });
          }}
          size="act-sm"
          type="button"
          variant="act"
        >
          Удалить
        </Button>
      </div>
    </li>
  );
}

function EditMemory({
  record,
  scopeKey,
}: {
  readonly record: MemoryRecord;
  readonly scopeKey: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(record.content?.text ?? "");
  const parsed = memoryTextSchema.safeParse(text);
  const update = api.memory.update.useMutation({
    onSuccess: () => {
      setOpen(false);
      router.refresh();
    },
  });
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!parsed.success) return;
    update.mutate({
      expectedRevision: record.revision,
      index: record.index,
      scopeKey,
      text: parsed.data,
    });
  };
  const fieldId = `memory-text-${String(record.index)}`;
  // Each opening starts from the text the page shows now, with no old error.
  const openChange = (next: boolean) => {
    if (next) {
      setText(record.content?.text ?? "");
      update.reset();
    }
    setOpen(next);
  };

  return (
    <Dialog onOpenChange={openChange} open={open}>
      <DialogTrigger
        render={
          <Button
            aria-label={`Изменить: ${record.content?.text ?? ""}`}
            size="act-sm"
            type="button"
            variant="act"
          />
        }
      >
        Изменить
      </DialogTrigger>
      <DialogContent>
        <DialogHeader className="pr-10 sm:pr-6">
          <DialogTitle>Изменить запись</DialogTitle>
          <DialogDescription>
            Бро увидит исправленный текст со следующего сообщения.
          </DialogDescription>
        </DialogHeader>
        <form noValidate onSubmit={submit}>
          <FieldGroup>
            <Field data-invalid={!parsed.success || undefined}>
              <FieldLabel htmlFor={fieldId}>Текст записи</FieldLabel>
              <Textarea
                aria-invalid={!parsed.success || undefined}
                id={fieldId}
                onChange={(event) => {
                  setText(event.target.value);
                }}
                value={text}
              />
              {parsed.success ? null : (
                <FieldError>
                  Такой текст сохранить нельзя: пустой, длиннее 2 КБ или с кодом
                  или паролем.
                </FieldError>
              )}
              {update.error ? (
                <FieldError>
                  Не сохранилось: запись изменилась, открой страницу заново.
                </FieldError>
              ) : null}
            </Field>
          </FieldGroup>
          <DialogFooter className="mt-4">
            <Button
              disabled={!parsed.success || update.isPending}
              type="submit"
              variant="act"
            >
              Сохранить
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MemoryHistory({
  record,
  scopeKey,
  timeZone,
}: {
  readonly record: MemoryRecord;
  readonly scopeKey: string;
  readonly timeZone: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const history = api.memory.history.useQuery(
    { index: record.index, scopeKey },
    { enabled: open }
  );
  const restore = api.memory.restore.useMutation({
    onSuccess: () => {
      setOpen(false);
      router.refresh();
    },
  });
  const rule = record.content?.category === "rule";
  const openChange = (next: boolean) => {
    if (next) restore.reset();
    setOpen(next);
  };

  return (
    <Dialog onOpenChange={openChange} open={open}>
      <DialogTrigger
        render={
          <Button
            aria-label={`История: ${record.content?.text ?? ""}`}
            size="act-sm"
            type="button"
            variant="act"
          />
        }
      >
        История
      </DialogTrigger>
      <DialogContent>
        <DialogHeader className="pr-10 sm:pr-6">
          <DialogTitle>История записи</DialogTitle>
          <DialogDescription>
            Прежние тексты, кроме правил, можно вернуть. Забытое не хранится.
          </DialogDescription>
        </DialogHeader>
        {history.data ? (
          <ul className="list-none" aria-label="Версии записи">
            {history.data.map((entry) => (
              <li
                className="flex min-w-0 items-baseline justify-between gap-4 border-t border-border py-[0.6rem] first:border-t-0"
                key={entry.revision}
              >
                <div className="type-row min-w-0 flex-1 wrap-break-word">
                  <p className="type-status text-muted-foreground">
                    {historyLine(entry, timeZone)}
                  </p>
                  {historyText(entry) === null ? null : (
                    <p>{historyText(entry)}</p>
                  )}
                </div>
                {entry.text !== null &&
                entry.revision !== record.revision &&
                !rule &&
                entry.category !== "rule" ? (
                  <Button
                    aria-label={`Вернуть: ${entry.text}`}
                    disabled={restore.isPending}
                    onClick={() => {
                      restore.mutate({
                        expectedRevision: record.revision,
                        index: record.index,
                        revision: entry.revision,
                        scopeKey,
                      });
                    }}
                    size="act-sm"
                    type="button"
                    variant="act"
                  >
                    Вернуть
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="type-status text-muted-foreground">
            {history.error ? "История не загрузилась." : "Загружаю…"}
          </p>
        )}
        {restore.error ? (
          <p className="type-status text-destructive" role="alert">
            Не вернулось: запись изменилась или память полна, открой страницу
            заново.
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Brings back a memory the digest removed or that expired, from the
 * timeline: its record is gone, so only the kept text names it.
 */
export function RestoreGoneMemory({
  expectedRevision,
  index,
  revision,
  scopeKey,
  text,
}: {
  readonly expectedRevision: number;
  readonly index: number;
  readonly revision: number;
  readonly scopeKey: string;
  readonly text: string;
}) {
  const router = useRouter();
  const restore = api.memory.restore.useMutation({
    onSuccess: () => {
      router.refresh();
    },
  });

  return (
    <>
      <Button
        aria-label={`Вернуть: ${text}`}
        disabled={restore.isPending}
        onClick={() => {
          restore.mutate({ expectedRevision, index, revision, scopeKey });
        }}
        size="act-sm"
        type="button"
        variant="act"
      >
        Вернуть
      </Button>
      {restore.error ? (
        <p className="type-status text-destructive" role="alert">
          Не вернулось: запись изменилась или память полна, открой страницу
          заново.
        </p>
      ) : null}
    </>
  );
}
