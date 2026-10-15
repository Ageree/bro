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

type ShareState = "failed" | "idle" | "locating" | "refused";

const hints: Readonly<Record<Exclude<ShareState, "idle">, string>> = {
  failed: "Не получилось отправить геопозицию — попробуй ещё раз.",
  locating: "Определяю геопозицию…",
  refused:
    "Браузер не дал геопозицию: разреши доступ к местоположению в настройках сайта.",
};

function currentPosition() {
  return new Promise<GeolocationPosition>((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, positionOptions);
  });
}

/**
 * The composer's «поделиться геопозицией» button (geolocation pilot): the
 * browser's point is stored as the person's own shared position, then the
 * chat sends `webShareText`, which the web channel reads as that point. A
 * point the browser refuses sends nothing. Shown only in the pilot.
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
  if (enabled.data !== true) return null;

  const handleClick = async () => {
    if (!("geolocation" in navigator)) {
      setState("refused");
      return;
    }
    setState("locating");
    let position: GeolocationPosition;
    try {
      position = await currentPosition();
    } catch {
      setState("refused");
      return;
    }
    try {
      await share.mutateAsync({
        accuracyM: position.coords.accuracy,
        lat: position.coords.latitude,
        lon: position.coords.longitude,
      });
      setState("idle");
      await onShared(webShareText);
    } catch {
      setState("failed");
    }
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
