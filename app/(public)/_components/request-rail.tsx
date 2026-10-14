"use client";

import { useRef, type ReactNode } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Button } from "@web/components/ui/button";
import styles from "../landing.module.css";

export function RequestRail({ children }: { readonly children: ReactNode }) {
  const rail = useRef<HTMLDivElement>(null);
  function move(direction: number) {
    const node = rail.current;
    const card = node?.firstElementChild;
    if (!node || !card) return;
    const step =
      card.getBoundingClientRect().width +
      Number.parseFloat(getComputedStyle(node).columnGap);
    const end = node.scrollWidth - node.clientWidth;
    let left = node.scrollLeft + direction * step;
    if (direction > 0 && node.scrollLeft >= end - 1) left = 0;
    if (direction < 0 && node.scrollLeft <= 1) left = end;
    node.scrollTo({
      left,
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
  }
  return (
    <section aria-label="Примеры поручений">
      <div className={styles.requestsGrid} id="bro-request-rail" ref={rail}>
        {children}
      </div>
      <div className={styles.requestControls}>
        <Button
          aria-controls="bro-request-rail"
          aria-label="Предыдущий пример"
          className={styles.requestControl}
          onClick={() => {
            move(-1);
          }}
          size="icon-lg"
          variant="outline"
        >
          <ArrowLeft aria-hidden="true" size={20} />
        </Button>
        <Button
          aria-controls="bro-request-rail"
          aria-label="Следующий пример"
          className={styles.requestControl}
          onClick={() => {
            move(1);
          }}
          size="icon-lg"
          variant="outline"
        >
          <ArrowRight aria-hidden="true" size={20} />
        </Button>
      </div>
    </section>
  );
}
