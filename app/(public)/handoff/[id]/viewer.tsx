"use client";

import { useEffect, useRef, useState } from "react";
import type {
  ChangeEvent,
  KeyboardEvent,
  PointerEvent,
  ReactNode,
} from "react";
import { z } from "zod";
import { Alert } from "@web/components/ui/alert";
import { Button } from "@web/components/ui/button";
import { Spinner } from "@web/components/ui/spinner";
import {
  closedBy,
  doneLabel,
  endedText,
  finishingText,
  framingText,
  goneText,
  liveHint,
  loadingText,
  noticeText,
  problemText,
  retryLabel,
  startingText,
} from "./copy";
import { Intro } from "./intro";
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
      readonly result: keyof typeof endedText;
    }
  | {
      readonly kind: "problem";
      readonly retry: boolean;
      readonly text: string;
    };

interface Bar {
  readonly host: string;
  readonly ok: boolean;
  readonly secure: boolean;
}

const base = "/eve/v1/login-handoff";
// Pixels a gesture must travel before it is more than a tap, and how often a
// drag is passed on: a captcha slider wants a smooth path, not the end points.
const dragThreshold = 8;
const dragEveryMs = 16;
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

/** A status or a result, set on a plate in the middle of the page. */
function Sheet({ children }: { readonly children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-[34rem] flex-col gap-4 bro-plate p-6 sm:p-8">
      {children}
    </div>
  );
}

/**
 * The sign-in window: a live picture of one page of Bro's browser, and the
 * person's pointer, taps and keys going back to it. The address bar is drawn here from what the
 * browser's worker reports of the page, outside the picture, so a page cannot
 * paint a bar of its own. Nothing typed is kept here.
 */
export function Viewer({ id }: { readonly id: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [bar, setBar] = useState<Bar | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [framed, setFramed] = useState(false);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  // Takes the phone's keyboard and its typing; the page's own key handler
  // takes a computer's keys.
  const keys = useRef<HTMLInputElement | null>(null);
  const lastMove = useRef(0);
  const socket = useRef<WebSocket | null>(null);
  const size = useRef({ h: 900, w: 1366 });
  const closing = useRef(false);
  const retries = useRef(0);
  const drag = useRef<
    | { kind: "dragging"; last: { x: number; y: number } }
    | { kind: "pending"; mouse: boolean; x: number; y: number }
    | { kind: "scrolling"; x: number; y: number }
    | null
  >(null);
  const lastDrag = useRef(0);
  const tapped = useRef(false);
  const lastScroll = useRef(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const preview = await call("GET", id, previewSchema);
      if (cancelled) return;
      if (preview?.domain === undefined) {
        setPhase({ kind: "problem", retry: false, text: goneText.missing });
      } else if (
        (preview.state === "pending" && preview.expired !== true) ||
        (preview.state === "claimed" && preview.mine === true)
      ) {
        setPhase({ domain: preview.domain, kind: "intro" });
      } else {
        setPhase({
          kind: "problem",
          retry: false,
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
      setFramed(true);
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
          setNotice(noticeText.blocked(message.host));
          break;
        }
        case "popup": {
          setNotice(noticeText.popup);
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
            result: closedBy[message.t],
          });
          break;
        }
        case "error": {
          setNotice(noticeText.error);
          break;
        }
      }
    });
    link.addEventListener("close", () => {
      if (closing.current || socket.current !== link) return;
      // A lost connection: the same window is opened again, with a new token.
      retries.current += 1;
      if (retries.current > 5) {
        setPhase({ kind: "problem", retry: true, text: problemText.failed });
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
        setPhase({ kind: "problem", retry: true, text: problemText.failed });
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
      setPhase(
        opened.kind === "gone"
          ? { kind: "problem", retry: false, text: goneText[opened.reason] }
          : {
              kind: "problem",
              retry: opened.kind !== "unsupported",
              text: problemText[opened.kind],
            }
      );
      return;
    }
    setPhase({ kind: "problem", retry: true, text: problemText.failed });
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
    drag.current = {
      kind: "pending",
      mouse: event.pointerType === "mouse",
      x: event.clientX,
      y: event.clientY,
    };
  }

  /** The button goes down where the gesture began, then follows the pointer. */
  function onPointerMove(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current) {
      // A mouse moving over the picture moves the pointer in the page too, so
      // hover menus and buttons answer. A finger only drags.
      const now = Date.now();
      if (event.pointerType !== "mouse" || now - lastMove.current < 50) return;
      lastMove.current = now;
      const point = place(event);
      send({ t: "move", x: point.x, y: point.y });
      return;
    }
    let state = current;
    if (current.kind === "pending") {
      const dx = event.clientX - current.x;
      const dy = current.y - event.clientY;
      if (Math.hypot(dx, dy) < dragThreshold) return;
      // A mouse always drags (the wheel scrolls). A finger moving sideways
      // drags, like a captcha slider; moving up or down scrolls the page.
      if (current.mouse || Math.abs(dx) >= Math.abs(dy)) {
        const rect = canvas.current?.getBoundingClientRect();
        if (!rect || rect.width === 0 || rect.height === 0) return;
        const origin = {
          x: ((current.x - rect.left) * size.current.w) / rect.width,
          y: ((current.y - rect.top) * size.current.h) / rect.height,
        };
        send({ t: "down", x: origin.x, y: origin.y });
        state = { kind: "dragging", last: origin };
      } else {
        state = { kind: "scrolling", x: current.x, y: current.y };
      }
      drag.current = state;
    }
    const now = Date.now();
    if (state.kind === "dragging") {
      if (now - lastDrag.current < dragEveryMs) return;
      lastDrag.current = now;
      const point = place(event);
      state.last = point;
      send({ t: "drag", x: point.x, y: point.y });
      return;
    }
    if (state.kind !== "scrolling" || now - lastScroll.current < 60) return;
    lastScroll.current = now;
    const rect = canvas.current?.getBoundingClientRect();
    if (!rect || rect.height === 0) return;
    const point = place(event);
    send({
      dy: ((state.y - event.clientY) * size.current.h) / rect.height,
      t: "scroll",
      x: point.x,
      y: point.y,
    });
    state.x = event.clientX;
    state.y = event.clientY;
  }

  function onPointerUp(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    drag.current = null;
    if (current?.kind === "pending") {
      const point = place(event);
      send({ t: "tap", x: point.x, y: point.y });
      tapped.current = true;
    } else if (current?.kind === "dragging") {
      // The last point the page was told of may lag the finger by a throttled
      // move: the release is where the finger lifted.
      const point = place(event);
      send({ t: "drag", x: point.x, y: point.y });
      send({ t: "up", x: point.x, y: point.y });
    }
  }

  /** A gesture the system took away: a held button is let go where it was. */
  function onPointerCancel() {
    const current = drag.current;
    drag.current = null;
    tapped.current = false;
    if (current?.kind === "dragging") {
      send({ t: "up", x: current.last.x, y: current.last.y });
    }
  }

  // iOS opens the keyboard only for a focus made inside `click`; one made in
  // `pointerup` is not taken as a tap and the keyboard stays shut.
  function onClick() {
    if (!tapped.current) return;
    tapped.current = false;
    keys.current?.focus();
  }

  function onKeyDown(
    event: KeyboardEvent<HTMLButtonElement | HTMLInputElement>
  ) {
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

  /** What a phone's keyboard typed: text goes in whole, whatever was typed. */
  function onTyped(event: ChangeEvent<HTMLInputElement>) {
    const typed = event.currentTarget.value;
    event.currentTarget.value = "";
    if (typed !== "") send({ s: typed, t: "text" });
  }

  async function cancel() {
    closing.current = true;
    send({ t: "cancel" });
    await call("POST", `${id}/cancel`, finishedSchema);
    setPhase({ kind: "ended", result: "cancelled" });
  }

  if (phase.kind === "loading") {
    return (
      <Sheet>
        <p className="type-body text-muted-foreground">
          <Spinner className="mr-2 inline" />
          {loadingText}
        </p>
      </Sheet>
    );
  }
  if (phase.kind === "problem") {
    return (
      <Sheet>
        <Alert variant="warning">{phase.text}</Alert>
        {phase.retry ? (
          <div>
            <Button
              className="w-full"
              onClick={() => {
                retries.current = 0;
                closing.current = false;
                void start();
              }}
              variant="paper"
            >
              {retryLabel}
            </Button>
          </div>
        ) : null}
      </Sheet>
    );
  }
  if (phase.kind === "intro") {
    return (
      <Intro
        domain={phase.domain}
        onStart={() => {
          void start();
        }}
      />
    );
  }
  if (phase.kind === "starting") {
    return (
      <Sheet>
        <p className="type-body text-muted-foreground">
          <Spinner className="mr-2 inline" />
          {startingText}
        </p>
      </Sheet>
    );
  }
  if (phase.kind === "finishing") {
    return (
      <Sheet>
        <p className="type-body text-muted-foreground">
          <Spinner className="mr-2 inline" />
          {finishingText}
        </p>
      </Sheet>
    );
  }
  if (phase.kind === "ended") {
    return (
      <Sheet>
        <Alert variant={phase.result === "yes" ? "success" : "default"}>
          {endedText[phase.result]}
        </Alert>
      </Sheet>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex min-h-11 items-center gap-2 rounded-full border-2 border-foreground bg-card px-4 py-2">
        <span aria-hidden="true">{bar?.secure === true ? "🔒" : "⚠️"}</span>
        <span className="type-label break-all">
          {bar === null ? "…" : bar.host}
        </span>
        {bar !== null && !bar.ok ? (
          <span className="type-caption text-destructive">не тот сайт</span>
        ) : null}
      </div>
      <p className="type-caption text-muted-foreground">{liveHint}</p>
      {notice === null ? null : <Alert variant="information">{notice}</Alert>}
      <div className="relative">
        <button
          aria-label="Окно компьютера Бро: нажимайте и печатайте прямо здесь"
          className="block w-full cursor-default touch-none overflow-hidden rounded-3xl border-2 border-foreground bg-muted p-0 shadow-[0_8px_30px_rgb(20_21_16/8%)] outline-none focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-foreground"
          onClick={onClick}
          onKeyDown={onKeyDown}
          onPointerCancel={onPointerCancel}
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
        {framed ? null : (
          <p className="type-body pointer-events-none absolute inset-0 flex items-center justify-center text-muted-foreground">
            <Spinner className="mr-2 inline" />
            {framingText}
          </p>
        )}
        <input
          aria-label="Ввод с клавиатуры телефона"
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          className="pointer-events-none absolute bottom-0 left-0 size-px opacity-0"
          name="handoff-keys"
          onChange={onTyped}
          onKeyDown={onKeyDown}
          ref={keys}
          spellCheck={false}
          tabIndex={-1}
          type="text"
        />
      </div>
      <div className="flex flex-wrap gap-3 pt-2">
        <Button
          onClick={() => {
            send({ t: "done" });
          }}
          variant="paper"
        >
          {doneLabel}
        </Button>
        <Button
          onClick={() => {
            void cancel();
          }}
          size="paper"
          variant="outline"
        >
          Отмена
        </Button>
      </div>
    </div>
  );
}
