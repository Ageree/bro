"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@web/components/ui/button";

/**
 * Puts text on the clipboard: through the Clipboard API where the page may
 * use it, otherwise through a hidden field the browser copies from (a
 * webview without the API, a page not served over https). False when neither
 * worked.
 */
export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.append(field);
    field.select();
    try {
      // oxlint-disable-next-line typescript/no-deprecated -- the only way to copy where the Clipboard API is missing
      return document.execCommand("copy");
    } finally {
      field.remove();
    }
  }
}

/**
 * A value the person has to carry elsewhere (a booking code, an order
 * number) with a button that copies it. When the browser refuses to copy,
 * the value is selected instead, so the system's own «Copy» is one tap away.
 */
export function Copyable({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "selected">("idle");
  const valueRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (status === "idle") return undefined;
    const timer = setTimeout(() => {
      setStatus("idle");
    }, 2400);
    return () => {
      clearTimeout(timer);
    };
  }, [status]);

  async function copy() {
    if (await copyText(value)) {
      setStatus("copied");
      return;
    }
    if (valueRef.current) {
      window.getSelection()?.selectAllChildren(valueRef.current);
    }
    setStatus("selected");
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg bg-background px-4 py-3">
      <p className="type-caption text-muted-foreground">{label}</p>
      <div className="flex items-center justify-between gap-3">
        <p
          className="type-scale-body min-w-0 font-[600] tracking-[0.06em] wrap-anywhere select-all"
          ref={valueRef}
        >
          {value}
        </p>
        <Button
          className="min-w-30 shrink-0"
          onClick={() => {
            void copy();
          }}
          size="sm"
          variant="outline"
        >
          {status === "copied" ? (
            <Check data-icon="inline-start" />
          ) : (
            <Copy data-icon="inline-start" />
          )}
          {status === "idle" && "Копировать"}
          {status === "copied" && "Скопировано"}
          {status === "selected" && "Выделено"}
        </Button>
      </div>
      <output className="sr-only">
        {status === "copied" && "Скопировано"}
      </output>
    </div>
  );
}
