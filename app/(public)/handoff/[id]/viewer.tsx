"use client";

import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { z } from "zod";
import { Alert } from "@web/components/ui/alert";
import { Button } from "@web/components/ui/button";
import { Input } from "@web/components/ui/input";
import { Spinner } from "@web/components/ui/spinner";
import {
  finishedSchema,
  namedKeys,
  openedSchema,
  previewSchema,
  readWorkerMessage,
  type ViewerMessage,
} from "./messages";

type Phase =
  | { readonly kind: "loading" }
  | { readonly domain: string; readonly kind: "intro" }
  | { readonly kind: "starting" }
  | { readonly kind: "live" }
  | { readonly kind: "finishing" }
  | {
      readonly kind: "ended";
      readonly result: "cancelled" | "failed" | "no" | "unknown" | "yes";
    }
  | { readonly kind: "problem"; readonly text: string };

interface Bar {
  readonly host: string;
  readonly ok: boolean;
  readonly secure: boolean;
}

const goneText = {
  ended: "Это окно уже закрыто.",
  expired: "Ссылка устарела. Попросите Бро прислать новую.",
  missing: "Такой ссылки нет.",
  taken:
    "Эту ссылку уже открыли с другого устройства. Попросите Бро прислать новую.",
} as const;

const problemText = {
  busy: "Браузер Бро сейчас занят поручением. Подождите минуту и нажмите «Начать» ещё раз.",
  failed: "Не получилось открыть окно. Попробуйте ещё раз через минуту.",
  unsupported:
    "На этом сервере окно входа ещё не работает. Напишите Бро, он запросит коды в чате.",
} as const;

const endedText = {
  cancelled: "Окно закрыто. Ничего не сохранено.",
  failed:
    "Окно закрылось раньше, чем вход завершился. Попросите Бро прислать новую ссылку.",
  no: "Похоже, сайт всё ещё просит войти. Напишите Бро, он пришлёт новую ссылку.",
  unknown: "Готово. Бро проверит вход при следующем поручении на этом сайте.",
  yes: "Готово: вход сохранён, Бро остался в вашем аккаунте. Возвращайтесь в чат.",
} as const;

const base = "/eve/v1/login-handoff";
const namedKeySet: ReadonlySet<string> = new Set(namedKeys);

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** One of the page's calls, its answer read against what it should be. */
async function call<Schema extends z.ZodType>(
  method: "GET" | "POST",
  path: string,
  schema: Schema
): Promise<z.output<Schema> | undefined> {
  try {
    const response = await fetch(`${base}/${path}`, {
      credentials: "same-origin",
      method,
    });
    if (!response.ok) return undefined;
    return schema.safeParse(await response.json()).data;
  } catch {
    return undefined;
  }
}

/**
 * The sign-in window: a picture of one page of Bro's browser, and the person's
 * taps and keys going back to it. The address bar is drawn here from what the
 * browser's worker reports of the page, outside the picture, so a page cannot
 * paint a bar of its own. Nothing typed is kept here.
 */
export function Viewer({ id }: { readonly id: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [bar, setBar] = useState<Bar | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [hidden, setHidden] = useState(true);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const size = useRef({ h: 900, w: 1366 });
  const closing = useRef(false);
  const retries = useRef(0);
  const drag = useRef<{ moved: boolean; x: number; y: number } | null>(null);
  const lastScroll = useRef(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const preview = await call("GET", id, previewSchema);
      if (cancelled) return;
      if (preview?.domain === undefined) {
        setPhase({ kind: "problem", text: goneText.missing });
      } else if (
        (preview.state === "pending" && preview.expired !== true) ||
        (preview.state === "claimed" && preview.mine === true)
      ) {
        setPhase({ domain: preview.domain, kind: "intro" });
      } else {
        setPhase({
          kind: "problem",
          text: preview.state === "pending" ? goneText.expired : goneText.ended,
        });
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(
    () => () => {
      closing.current = true;
      socket.current?.close();
    },
    []
  );

  function send(message: ViewerMessage) {
    const current = socket.current;
    if (current?.readyState === WebSocket.OPEN) {
      current.send(JSON.stringify(message));
    }
  }

  async function finish() {
    setPhase({ kind: "finishing" });
    for (let attempt = 0; attempt < 45; attempt += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- The browser is asked again until it has written what the site gave.
      const finished = await call("POST", `${id}/finish`, finishedSchema);
      if (finished?.state === "done") {
        const result =
          finished.signedIn === true
            ? "yes"
            : finished.signedIn === false
              ? "no"
              : "unknown";
        setPhase({ kind: "ended", result });
        return;
      }
      if (finished?.state !== undefined && finished.state !== "claimed") {
        setPhase({
          kind: "ended",
          result: finished.state === "cancelled" ? "cancelled" : "failed",
        });
        return;
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- As above: one look a second.
      await wait(1_000);
    }
    setPhase({ kind: "ended", result: "unknown" });
  }

  function draw(data: string, width: number, height: number) {
    const image = new Image();
    image.addEventListener("load", () => {
      const target = canvas.current;
      const context = target?.getContext("2d");
      if (!target || !context) return;
      size.current = { h: height, w: width };
      if (target.width !== image.width) target.width = image.width;
      if (target.height !== image.height) target.height = image.height;
      context.drawImage(image, 0, 0);
    });
    image.src = `data:image/jpeg;base64,${data}`;
  }

  function connect(viewer: { readonly token: string; readonly url: string }) {
    const link = new WebSocket(viewer.url);
    socket.current = link;
    link.addEventListener("open", () => {
      send({ t: "auth", token: viewer.token });
      setPhase({ kind: "live" });
    });
    link.addEventListener("message", (event) => {
      const raw = z.string().safeParse(event.data);
      const message = raw.success ? readWorkerMessage(raw.data) : undefined;
      if (message === undefined) return;
      switch (message.t) {
        case "frame": {
          draw(message.d, message.w, message.h);
          break;
        }
        case "url": {
          setBar({
            host: message.host,
            ok: message.ok,
            secure: message.secure,
          });
          break;
        }
        case "blocked": {
          setNotice(
            `Переход на ${message.host} закрыт: это не тот сайт, куда вы входите.`
          );
          break;
        }
        case "popup": {
          setNotice(
            "Открылось окно входа (например, через Яндекс или VK). Оно показано здесь."
          );
          break;
        }
        case "popup-closed": {
          setNotice(null);
          break;
        }
        case "done": {
          closing.current = true;
          void finish();
          break;
        }
        case "cancel":
        case "expired": {
          closing.current = true;
          setPhase({
            kind: "ended",
            result: message.t === "cancel" ? "cancelled" : "failed",
          });
          break;
        }
        case "error": {
          setNotice("Браузер не отвечает. Пробую ещё раз.");
          break;
        }
      }
    });
    link.addEventListener("close", () => {
      if (closing.current || socket.current !== link) return;
      // A lost connection: the same window is opened again, with a new token.
      retries.current += 1;
      if (retries.current > 5) {
        setPhase({ kind: "problem", text: problemText.failed });
        return;
      }
      void wait(1_000).then(start);
    });
  }

  async function start() {
    setPhase({ kind: "starting" });
    for (let attempt = 0; attempt < 60; attempt += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- The browser starts in its own time; the page asks again.
      const opened = await call("POST", `${id}/open`, openedSchema);
      if (opened === undefined) {
        setPhase({ kind: "problem", text: problemText.failed });
        return;
      }
      if (opened.kind === "ready") {
        connect(opened.viewer);
        return;
      }
      if (opened.kind === "starting") {
        // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
        await wait(Math.min(Math.max(opened.retryAfterMs, 2_000), 10_000));
        continue;
      }
      setPhase({
        kind: "problem",
        text:
          opened.kind === "gone"
            ? goneText[opened.reason]
            : problemText[opened.kind],
      });
      return;
    }
    setPhase({ kind: "problem", text: problemText.failed });
  }

  function place(event: PointerEvent<HTMLButtonElement>) {
    const rect = canvas.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    return {
      x: ((event.clientX - rect.left) * size.current.w) / rect.width,
      y: ((event.clientY - rect.top) * size.current.h) / rect.height,
    };
  }

  function onPointerDown(event: PointerEvent<HTMLButtonElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { moved: false, x: event.clientX, y: event.clientY };
  }

  function onPointerMove(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current) return;
    const dy = current.y - event.clientY;
    if (!current.moved && Math.hypot(event.clientX - current.x, dy) < 8) return;
    current.moved = true;
    const now = Date.now();
    if (now - lastScroll.current < 60) return;
    lastScroll.current = now;
    const rect = canvas.current?.getBoundingClientRect();
    if (!rect || rect.height === 0) return;
    const point = place(event);
    send({
      dy: (dy * size.current.h) / rect.height,
      t: "scroll",
      x: point.x,
      y: point.y,
    });
    current.x = event.clientX;
    current.y = event.clientY;
  }

  function onPointerUp(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    drag.current = null;
    if (current && !current.moved) {
      const point = place(event);
      send({ t: "tap", x: point.x, y: point.y });
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (namedKeySet.has(event.key)) {
      event.preventDefault();
      const key = namedKeys.find((name) => name === event.key);
      if (key !== undefined) send({ k: key, t: "key" });
    } else if (event.key.length === 1) {
      event.preventDefault();
      send({ s: event.key, t: "text" });
    }
  }

  function sendText() {
    if (text === "") return;
    send({ s: text, t: "text" });
    setText("");
  }

  async function cancel() {
    closing.current = true;
    send({ t: "cancel" });
    await call("POST", `${id}/cancel`, finishedSchema);
    setPhase({ kind: "ended", result: "cancelled" });
  }

  if (phase.kind === "loading") {
    return (
      <p className="type-body text-muted-foreground">
        <Spinner className="mr-2 inline" />
        Открываю…
      </p>
    );
  }
  if (phase.kind === "problem") {
    return <Alert variant="warning">{phase.text}</Alert>;
  }
  if (phase.kind === "intro") {
    return (
      <div className="flex max-w-[34rem] flex-col gap-4">
        <h1 className="type-page-title">Вход на {phase.domain}</h1>
        <p className="type-body">
          Сейчас откроется окно браузера Бро. Войдите на {phase.domain} сами:
          логин, пароль и код вводите прямо там. Бро не сохраняет их. Если сайт
          предлагает «Запомнить меня», отметьте это — вход продержится дольше.
          Когда войдёте, нажмите «Готово».
        </p>
        <p className="type-caption text-muted-foreground">
          Ссылка работает с одного устройства. Не пересылайте её никому.
        </p>
        <div>
          <Button
            onClick={() => {
              void start();
            }}
            variant="paper"
          >
            Начать
          </Button>
        </div>
      </div>
    );
  }
  if (phase.kind === "starting") {
    return (
      <p className="type-body text-muted-foreground">
        <Spinner className="mr-2 inline" />
        Запускаю браузер Бро. Это может занять до минуты…
      </p>
    );
  }
  if (phase.kind === "finishing") {
    return (
      <p className="type-body text-muted-foreground">
        <Spinner className="mr-2 inline" />
        Сохраняю вход…
      </p>
    );
  }
  if (phase.kind === "ended") {
    return (
      <Alert variant={phase.result === "yes" ? "success" : "default"}>
        {endedText[phase.result]}
      </Alert>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 border border-border px-3 py-2">
        <span aria-hidden="true">{bar?.secure === true ? "🔒" : "⚠️"}</span>
        <span className="type-label break-all">
          {bar === null ? "…" : bar.host}
        </span>
        {bar !== null && !bar.ok ? (
          <span className="type-caption text-destructive">не тот сайт</span>
        ) : null}
      </div>
      {notice === null ? null : <Alert variant="information">{notice}</Alert>}
      <button
        aria-label="Окно браузера Бро: коснитесь поля, чтобы ввести текст"
        className="block w-full cursor-default touch-none border border-border bg-muted p-0"
        onKeyDown={onKeyDown}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={(event) => {
          send({
            dy: event.deltaY,
            t: "scroll",
            x: size.current.w / 2,
            y: size.current.h / 2,
          });
        }}
        type="button"
      >
        <canvas
          className="block w-full"
          height={900}
          ref={canvas}
          width={1366}
        />
      </button>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Текст для поля на странице"
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          className="min-w-[12rem] flex-1"
          name="handoff-text"
          onChange={(event) => {
            setText(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              sendText();
            }
          }}
          placeholder="Коснитесь поля на странице, введите здесь"
          spellCheck={false}
          type={hidden ? "password" : "text"}
          value={text}
        />
        <Button onClick={sendText} variant="outline">
          Вставить в поле
        </Button>
        <Button
          onClick={() => {
            setHidden((value) => !value);
          }}
          variant="quiet"
        >
          {hidden ? "Показать" : "Скрыть"}
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() => {
            send({ k: "Enter", t: "key" });
          }}
          variant="outline"
        >
          Enter
        </Button>
        <Button
          onClick={() => {
            send({ k: "Tab", t: "key" });
          }}
          variant="outline"
        >
          Tab
        </Button>
        <Button
          onClick={() => {
            send({ k: "Backspace", t: "key" });
          }}
          variant="outline"
        >
          ⌫
        </Button>
        <Button
          onClick={() => {
            send({ t: "back" });
          }}
          variant="outline"
        >
          Назад
        </Button>
      </div>
      <div className="flex flex-wrap gap-3 pt-2">
        <Button
          onClick={() => {
            send({ t: "done" });
          }}
          variant="paper"
        >
          Готово — я вошёл
        </Button>
        <Button
          onClick={() => {
            void cancel();
          }}
          variant="quiet"
        >
          Отмена
        </Button>
      </div>
    </div>
  );
}
