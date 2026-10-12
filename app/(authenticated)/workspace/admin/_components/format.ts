const zone = "Europe/Moscow";

/** A moment as the owner reads it: Moscow time, day and minute. */
export function formatMoment(date: Date | null) {
  if (!date) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    timeZone: zone,
  }).format(date);
}

export function formatRub(value: number) {
  return `${value.toLocaleString("ru-RU", { maximumFractionDigits: value < 10 ? 2 : 0 })} ₽`;
}

export function formatDuration(ms: number | null) {
  if (ms === null) return "—";
  return ms < 1000 ? `${String(ms)} мс` : `${(ms / 1000).toFixed(1)} с`;
}
