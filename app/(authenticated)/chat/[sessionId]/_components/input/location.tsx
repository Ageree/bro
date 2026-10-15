"use client";

import { MapPinIcon } from "lucide-react";
import { useState } from "react";
import { PromptInputButton } from "@web/components/ai-elements/prompt-input";
import { Spinner } from "@web/components/ui/spinner";
import { webShareText } from "@shared/location/share";
import { api } from "@web/trpc/client";

/** How the browser is asked: a fresh, precise point, a minute old at most. */
const positionOptions: PositionOptions = {
  enableHighAccuracy: true,
  maximumAge: 60_000,
  timeout: 15_000,
};

type ShareState =
  | "failed"
  | "idle"
  | "imprecise"
  | "locating"
  | "refused"
  | "unavailable";

const hints: Readonly<Record<Exclude<ShareState, "idle">, string>> = {
  failed: "Не получилось отправить геопозицию — попробуй ещё раз.",
  imprecise:
    "Браузер знает место только приблизительно (по сети) — включи точное местоположение или пришли точку с телефона.",
  locating: "Определяю геопозицию…",
  refused:
    "Браузер не дал геопозицию: разреши доступ к местоположению в настройках сайта.",
  unavailable: "Не удалось определить геопозицию — попробуй ещё раз.",
};

/** The server's bound (`location.share`): coarser is a guess by the network. */
const coarsestAccuracyM = 100_000;

/**
 * How long a stored point is still the one to send: the web channel reads it
 * for two minutes (`agent/lib/location/context.ts`), and the server stores a
 * new one only 10 s after the last (`recordWebShare`).
 */
const storedForMs = 90_000;

function currentPosition() {
  return new Promise<GeolocationPosition>((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, positionOptions);
  });
}

/**
 * The composer's «поделиться геопозицией» button (geolocation pilot): the
 * browser's point is stored as the person's own shared position, then the
 * chat sends `webShareText`, which the web channel reads as that point. A
 * point the browser refuses sends nothing. A point stored whose message did
 * not go is sent again on the next click without storing it twice. Shown
 * only in the pilot.
 */
export function ShareLocationButton({
  disabled,
  onShared,
}: {
  readonly disabled: boolean;
  readonly onShared: (text: string) => Promise<void>;
}) {
  const enabled = api.location.enabled.useQuery(undefined, {
    staleTime: Number.POSITIVE_INFINITY,
  });
  const share = api.location.share.useMutation();
  const [state, setState] = useState<ShareState>("idle");
  const [storedAt, setStoredAt] = useState<number | null>(null);
  if (enabled.data !== true) return null;

  const send = async () => {
    try {
      await onShared(webShareText);
      setStoredAt(null);
      setState("idle");
    } catch {
      setState("failed");
    }
  };

  const handleClick = async () => {
    if (storedAt !== null && Date.now() - storedAt < storedForMs) {
      await send();
      return;
    }
    if (!("geolocation" in navigator)) {
      setState("unavailable");
      return;
    }
    setState("locating");
    let position: GeolocationPosition;
    try {
      position = await currentPosition();
    } catch (error) {
      setState(
        error instanceof GeolocationPositionError &&
          error.code === error.PERMISSION_DENIED
          ? "refused"
          : "unavailable"
      );
      return;
    }
    if (position.coords.accuracy > coarsestAccuracyM) {
      setState("imprecise");
      return;
    }
    try {
      await share.mutateAsync({
        accuracyM: position.coords.accuracy,
        lat: position.coords.latitude,
        lon: position.coords.longitude,
      });
    } catch {
      setState("failed");
      return;
    }
    setStoredAt(Date.now());
    await send();
  };

  const busy = state === "locating" || share.isPending;
  return (
    <div className="flex items-center gap-2">
      <PromptInputButton
        aria-label="Поделиться геопозицией"
        disabled={disabled || busy}
        onClick={() => void handleClick()}
        tooltip="Поделиться геопозицией"
      >
        {busy ? <Spinner /> : <MapPinIcon className="size-4" />}
      </PromptInputButton>
      {state === "idle" ? null : (
        <output className="type-caption text-muted-foreground">
          {hints[state]}
        </output>
      )}
    </div>
  );
}
