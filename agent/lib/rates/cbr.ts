// The Central Bank of Russia's official exchange rates, from its daily XML (cbr.ru, no key, windows-1251).
// Each working day the bank sets the rate for the next calendar day; weekends and holidays keep the last
// one. Asked for a date it has not set yet, it answers with the latest set and that set's own date, so
// «tomorrow» is told only when its date is tomorrow's. Through web search the voice named a February euro
// for October's 4 times in 6, and the bank's own figure came 0.65 s sooner (probe 28.10).

const dailyUrl = "https://www.cbr.ru/scripts/XML_daily.asp";
const requestTimeoutMs = 2500;
/** A set does not change once published: a day's answer is kept this long. */
const keptMs = 15 * 60_000;
const moscow = "Europe/Moscow";

/** One currency of a set: `rubles` for `nominal` units, as the bank writes them. */
interface OfficialRate {
  readonly code: string;
  readonly name: string;
  readonly nominal: number;
  readonly rubles: number;
}

/** The rates the bank set for `date` (DD.MM.YYYY, its own way of writing it). */
interface RateSet {
  readonly date: string;
  readonly rates: ReadonlyMap<string, OfficialRate>;
}

const kept = new Map<
  string,
  { readonly set: RateSet; readonly until: number }
>();

/** The day as the bank writes it, by Moscow's calendar. */
function bankDate(day: Date) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    timeZone: moscow,
    year: "numeric",
  }).format(day);
}

const valuteBlock = /<Valute\b[^>]*>(.*?)<\/Valute>/gsu;

function field(block: string, name: string) {
  return new RegExp(`<${name}>([^<]*)</${name}>`, "u").exec(block)?.[1];
}

/** The bank's XML as a set; a set without its date or rates is no answer. */
function readRateSet(xml: string): RateSet | undefined {
  const date = /<ValCurs\b[^>]*\bDate="(\d\d\.\d\d\.\d{4})"/u.exec(xml)?.[1];
  if (date === undefined) return undefined;
  const rates = new Map<string, OfficialRate>();
  for (const [, block = ""] of xml.matchAll(valuteBlock)) {
    const code = field(block, "CharCode");
    const name = field(block, "Name");
    const nominal = Number(field(block, "Nominal"));
    const rubles = Number(field(block, "Value")?.replace(",", "."));
    if (
      code === undefined ||
      name === undefined ||
      !Number.isFinite(nominal) ||
      !Number.isFinite(rubles)
    )
      continue;
    rates.set(code, { code, name, nominal, rubles });
  }
  return rates.size > 0 ? { date, rates } : undefined;
}

async function rateSet(day: Date, signal: AbortSignal) {
  const asked = bankDate(day);
  const known = kept.get(asked);
  if (known && known.until > Date.now()) return known.set;
  const url = new URL(dailyUrl);
  url.searchParams.set("date_req", asked.replaceAll(".", "/"));
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]),
  });
  if (!response.ok)
    throw new Error(`The bank answered ${String(response.status)}`);
  const set = readRateSet(
    new TextDecoder("windows-1251").decode(await response.arrayBuffer())
  );
  if (set === undefined) throw new Error("The bank's answer had no rates");
  kept.set(asked, { set, until: Date.now() + keptMs });
  return set;
}

/** «80 руб. 53 коп.»: the voice read «90,0977» as «90 рублей 9 копеек» (probe 28.10). */
function inRubles(value: number) {
  const kopecks = Math.round(value * 100);
  return `${String(Math.floor(kopecks / 100))} руб. ${String(kopecks % 100).padStart(2, "0")} коп.`;
}

function rateLine(rate: OfficialRate) {
  return `${rate.code} — ${rate.nominal === 1 ? "" : `${String(rate.nominal)} `}${rate.name}: ${inRubles(rate.rubles)}`;
}

/**
 * The bank's rates for `codes` (ISO, such as USD, EUR, CNY) today and, once set, tomorrow, as lines for the
 * model; codes the bank does not quote are named as such.
 */
export async function officialRateLines(
  codes: readonly string[],
  now: Date,
  signal: AbortSignal
) {
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60_000);
  const [today, next] = await Promise.all([
    rateSet(now, signal),
    rateSet(tomorrow, signal).catch(() => undefined),
  ]);
  const wanted = [...new Set(codes.map((code) => code.trim().toUpperCase()))];
  const lines = [`Курс ЦБ РФ на ${today.date}:`];
  const missing: string[] = [];
  for (const code of wanted) {
    const rate = today.rates.get(code);
    if (rate === undefined) missing.push(code);
    else lines.push(rateLine(rate));
  }
  if (next !== undefined && next.date === bankDate(tomorrow)) {
    lines.push(`Курс ЦБ РФ на завтра, ${next.date}:`);
    for (const code of wanted) {
      const rate = next.rates.get(code);
      if (rate !== undefined) lines.push(rateLine(rate));
    }
  }
  if (missing.length > 0)
    lines.push(`ЦБ не устанавливает курс для: ${missing.join(", ")}.`);
  return lines.join("\n");
}
