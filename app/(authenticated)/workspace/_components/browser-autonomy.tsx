"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@web/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@web/components/ui/dialog";
import { Switch } from "@web/components/ui/switch";
import { api } from "@web/trpc/client";

export function BrowserAutonomy({ broad }: { readonly broad: boolean }) {
  const router = useRouter();
  const [consentOpen, setConsentOpen] = useState(false);
  const mutation = api.settings.setBrowserAutonomy.useMutation({
    onSuccess: () => {
      setConsentOpen(false);
      router.refresh();
    },
  });

  const change = (checked: boolean) => {
    if (checked) {
      setConsentOpen(true);
      return;
    }
    mutation.mutate({ broad: false });
  };

  return (
    <>
      <div className="flex flex-col items-end gap-2">
        <Switch
          aria-label="Разрешить Bro самостоятельно выполнять действия на сайтах"
          checked={broad}
          disabled={mutation.isPending}
          onCheckedChange={change}
        />
        {mutation.error && !consentOpen ? (
          <p
            aria-live="polite"
            className="max-w-48 text-right text-destructive"
            role="alert"
          >
            Не удалось сохранить настройку. Попробуй ещё раз.
          </p>
        ) : null}
      </div>
      <Dialog onOpenChange={setConsentOpen} open={consentOpen}>
        <DialogContent className="rounded-none sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              Разрешить действия без повторных подтверждений?
            </DialogTitle>
            <DialogDescription>
              В рамках поручений, которые ты сам даёшь Bro, он сможет оформлять
              покупки и бронирования, отправлять сообщения и формы, менять
              настройки аккаунтов и удалять данные без подтверждения каждого
              шага.
            </DialogDescription>
          </DialogHeader>
          <div className="type-supporting-body space-y-3">
            <p>
              Это широкое разрешение на выполнение поручений, а не гарантия
              контроля каждого действия на стороне внешнего сайта. Bro
              по-прежнему действует только в пределах твоего запроса.
            </p>
            <p className="text-muted-foreground">
              Разрешение можно отозвать здесь: для будущих действий снова
              потребуется подтверждение. Уже запущенный внешний браузер это не
              остановит. Просмотр сайтов и подготовка действий работают
              автоматически независимо от настройки.
            </p>
            {mutation.error ? (
              <p role="alert" className="text-destructive">
                Не удалось сохранить настройку. Попробуй ещё раз.
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              Отмена
            </DialogClose>
            <Button
              disabled={mutation.isPending}
              onClick={() => {
                mutation.mutate({ broad: true });
              }}
              type="button"
            >
              Разрешить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
