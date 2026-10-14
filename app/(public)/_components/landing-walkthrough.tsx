"use client";

import { Play, X } from "lucide-react";
import { cn } from "@web/components/class-names";
import { Button } from "@web/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@web/components/ui/dialog";
import styles from "../landing.module.css";

export function LandingWalkthrough({
  fontClassName,
}: {
  readonly fontClassName: string;
}) {
  return (
    <Dialog>
      <DialogTrigger
        className={cn(styles.walkthrough, styles.walkthroughTrigger)}
      >
        <span className={styles.walkthroughEyebrow}>От сообщения к делу</span>
        <span className={styles.walkthroughTitle}>Один день с bro.</span>
        <span className={styles.playButton}>
          <Play aria-hidden="true" size={18} />
          Посмотреть пример
        </span>
      </DialogTrigger>
      <DialogContent
        animated={false}
        className={cn(fontClassName, styles.landing, styles.walkthroughDialog)}
        showCloseButton={false}
      >
        <DialogTitle>Один день с bro.</DialogTitle>
        <DialogDescription>
          Иллюстрация сценария, не видео и не запись реального разговора.
        </DialogDescription>
        <div className={styles.walkthroughContent}>
          <ol>
            <li>
              <span>01</span>
              <h3>Ты рассказываешь.</h3>
              <p>«Хочу устроить ужин в субботу. Поможешь найти место?»</p>
            </li>
            <li>
              <span>02</span>
              <h3>bro уточняет.</h3>
              <p>Время, район, предпочтения — чтобы искать подходящее тебе.</p>
            </li>
            <li>
              <span>03</span>
              <h3>Вы решаете вместе.</h3>
              <p>Варианты и следующие шаги остаются в одной переписке.</p>
            </li>
          </ol>
        </div>
        <DialogClose
          render={
            <Button
              className={styles.walkthroughClose}
              size="icon-lg"
              variant="ghost"
            />
          }
        >
          <X aria-hidden="true" size={20} />
          <span className="sr-only">Закрыть пример</span>
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}
