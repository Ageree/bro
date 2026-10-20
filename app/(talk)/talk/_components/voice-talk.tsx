"use client";

import { motion } from "motion/react";
import Link from "next/link";
import { Button } from "@web/components/ui/button";
import { cn } from "@web/components/class-names";
import { type TalkState, useVoiceTalk } from "./use-voice-talk";

/**
 * The voice conversation as one ink circle on paper: it breathes while Bro
 * listens, swells while Bro speaks, and a ring turns around it while Bro is
 * busy with something the person asked.
 */
export function VoiceTalk() {
  const talk = useVoiceTalk();
  const live = talk.state.kind === "live";

  return (
    <main className="flex min-h-dvh flex-col items-center justify-between px-bro-pad pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <header className="flex w-full max-w-xl items-center justify-between">
        <p className="type-doc-title">Bro</p>
        <Button
          nativeButton={false}
          render={<Link href={chatHref(talk.chatId)} />}
          size="sm"
          variant="quiet"
        >
          Чат
        </Button>
      </header>

      <section className="flex flex-col items-center gap-8">
        <div className="relative flex size-56 items-center justify-center">
          {talk.working && live ? (
            <motion.div
              animate={{ rotate: 360 }}
              aria-hidden
              className="absolute inset-0 rounded-full border-2 border-foreground border-t-transparent"
              transition={{ duration: 1.4, ease: "linear", repeat: Infinity }}
            />
          ) : null}
          <motion.button
            animate={orbMotion(talk.state, talk.speaking)}
            aria-label={live ? "Завершить разговор" : "Начать разговор"}
            className={cn(
              "size-40 rounded-full bg-foreground outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-foreground",
              !live && talk.state.kind !== "starting" && "opacity-35"
            )}
            onClick={live ? talk.end : talk.start}
            transition={{
              duration: talk.speaking ? 0.6 : 2.4,
              ease: "easeInOut",
              repeat: Infinity,
            }}
            type="button"
          />
        </div>
        <div className="flex min-h-20 max-w-sm flex-col items-center gap-2 text-center">
          <p className="type-sec-title">{caption(talk.state, talk.working)}</p>
          {talk.state.kind === "failed" ? (
            <p className="type-fine text-muted-foreground">
              {talk.state.detail}
            </p>
          ) : null}
          {live && talk.lastRequest !== undefined ? (
            <p className="type-fine line-clamp-2 text-muted-foreground">
              «{talk.lastRequest}»
            </p>
          ) : null}
        </div>
      </section>

      <footer className="flex flex-col items-center gap-3">
        {talk.silentAudio && live ? (
          <Button onClick={talk.unmute} size="lg" variant="paper">
            Включить звук
          </Button>
        ) : null}
        {live || talk.state.kind === "starting" ? (
          <Button onClick={talk.end} size="lg" variant="outline">
            Завершить
          </Button>
        ) : (
          <Button onClick={talk.start} size="lg" variant="paper">
            {talk.state.kind === "denied"
              ? "Разрешить микрофон"
              : talk.state.kind === "failed"
                ? "Попробовать ещё раз"
                : "Продолжить разговор"}
          </Button>
        )}
      </footer>
    </main>
  );
}

function chatHref(chatId: string | undefined) {
  return chatId === undefined ? "/chat" : `/chat/${encodeURIComponent(chatId)}`;
}

function caption(state: TalkState, working: boolean) {
  if (state.kind === "live") return working ? "Занимаюсь…" : "Слушаю";
  if (state.kind === "denied") return "Нужен доступ к микрофону";
  if (state.kind === "failed") return "Не получилось соединиться";
  if (state.kind === "ended")
    return state.reason === "idle"
      ? "Разговор закончился: долго было тихо"
      : "Разговор закончен";
  return "Подключаюсь…";
}

function orbMotion(state: TalkState, speaking: boolean) {
  if (state.kind !== "live") return { scale: 1 };
  return speaking ? { scale: [1, 1.12, 1] } : { scale: [1, 1.04, 1] };
}
