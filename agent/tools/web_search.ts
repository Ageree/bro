import { defineDynamic, defineTool } from "eve/tools";
import { defaultWebSearch } from "eve/tools/web_search";
import { browserUseConfigured } from "@agent/lib/browser-use/client";
import { resolveModeValue } from "@agent/lib/mode";
import { openRouterActive } from "@shared/model/provider";
import {
  searchWeb,
  type WebSearchInput,
  webSearchInputSchema,
  type WebSearchResult,
} from "@agent/lib/web-search/openrouter";

export const openRouterWebSearch = defineTool({
  description:
    "Search the web for real-time information: current events, prices, places, services, schedules and anything that may have changed since the knowledge cutoff. Returns up to eight pages, each with its title, URL and an excerpt of what the page says; the excerpt often already shows a price, an average bill, opening hours or an address. Read a page with web_fetch when its excerpt is not enough. Search pages show timetables and typical fares, not what is on sale: for tickets, seats or rooms on given dates use browser_task when it is offered.",
  inputSchema: webSearchInputSchema,
  async execute(input, ctx) {
    try {
      const results = formatResults(await searchWeb(input, ctx.abortSignal));
      return ticketSearch(input) && browserUseConfigured()
        ? `${results}\n\n${ticketSearchNote}`
        : results;
    } catch (error) {
      if (ctx.abortSignal.aborted) throw error;
      return `search failed: ${failureReason(error)}. Do not repeat this query as is: try one shorter or differently worded query${input.sites ? " or drop sites" : ""}, or read a page you already know with web_fetch.`;
    }
  },
});

function failureReason(cause: unknown) {
  if (!(cause instanceof Error)) return "the search could not be completed";
  return cause.name === "TimeoutError" ? "the search timed out" : cause.message;
}

/**
 * A train, a flight, a ticket or a stay: something sold for given dates.
 * Whole words where a stem would catch something else: «поездка», «шкаф-купе»,
 * book shelves («полки» only as a berth), «Барнаул».
 */
const tripWords =
  /(?<!\p{L})(?:поезд(?:а|е|ом|у|ов|ами|ах)?(?!\p{L})|(?:жд|ж\/д|ржд)(?!\p{L})|сапсан|ласточк|электричк|билет|авиабилет|рейс|перел[её]т|самол[её]т|(?<![\p{L}-])купе(?!\p{L})|плацкарт|(?:нижн|верхн|боков)\p{L}*\s+полк|отел|гостиниц|хостел|(?:trains?|flights?|tickets?|fares?|hotels?|hostels?)(?!\p{L}))/iu;

/**
 * A date, a day or a seat: what is on sale then, not a timetable. A date in
 * digits has a two-digit month («03.10», «3.10.2026»), so a rating «4.5» is
 * none; «завтра» is not «завтрак».
 */
const onDatesWords =
  /\d{1,2}\s*(?:январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|(?<![\d.])\d{1,2}\.\d{2}(?!\d)|(?<!\p{L})(?:(?:завтра|послезавтра|сегодня)(?!\p{L})|выходн|понедельник|вторник|сред[ау](?!\p{L})|четверг|пятниц|суббот|воскресен|недел|наличи|свободн|мест[ао]?(?!\p{L})|нижн|верхн|(?:tomorrow|tonight|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|available|availability|seats?)(?!\p{L}))/iu;

/**
 * Searches that are no fare: a flight's status, and a pick of a place or a
 * person where a hotel is only a landmark or a day is only when — «где
 * поужинать рядом с отелем в субботу», «сборка шкафа-купе завтра», «отели
 * Казани с рейтингом 4.5». Recommending a place or a master is done
 * without a browser (recommendations.md), and a run nobody asked for costs
 * money.
 */
const notTicketWords =
  /(?<!\p{L})(?:статус|задерж|табло|опаздыва|(?:рядом|возле|около|недалеко|пешком|напротив)(?:\s+(?:с|со|от|до))?\s+(?:отел|гостиниц|хостел)|ресторан|кафе|кофейн|бар(?:а|ы|ов)?(?!\p{L})|ужин|поужин|обед|пообед|мастер|сборк|шкаф|мебел|рейтинг|театр|концерт|спектакл|кино|выставк|музе|(?:near|by|around|close\s+to)\s+(?:the\s+)?hotel|(?:status|delay|delayed|restaurants?|cafes?|bars?|dinner|lunch|concerts?|theatre|theater|museum)(?!\p{L}))/iu;

/** Sellers and searches of tickets and stays. */
const ticketSites =
  /(?:^|\.)(?:rzd\.ru|tutu\.ru|aviasales\.ru|ostrovok\.ru|booking\.com|travel\.yandex\.ru|aeroflot\.ru|s7\.ru|pobeda\.aero|utair\.ru|onetwotrip\.com|sutochno\.ru)/iu;

/**
 * Whether a search looks for tickets, seats or rooms on given dates, which
 * a search engine cannot answer: it sees timetables and typical fares, not
 * what is on sale. On 25.09 (RU d13) «найди мне поезд до казани на
 * следующие выходные» went to two searches of rzd.ru and tutu.ru, and the
 * person got a timetable link and «наличие нижней полки не подтверждено»
 * while their saved rule was «в поезде только нижняя полка».
 */
function ticketSearch(input: WebSearchInput) {
  if (notTicketWords.test(input.query)) return false;
  return (
    (tripWords.test(input.query) && onDatesWords.test(input.query)) ||
    (input.sites ?? []).some((site) => ticketSites.test(site))
  );
}

/**
 * What a ticket search is followed by, in the result the model reads last:
 * the rule to search tickets with a browser run lived only in the prompt,
 * and gpt-6-luna answered from the timetable instead.
 */
const ticketSearchNote =
  "Note: these pages show timetables and typical fares, not what is on sale on those dates. When the person wants a train, a flight or a room on given dates — what is on sale, the fare, a lower berth, an aisle seat — start browser_task now without allowSubmit on the seller's site (ticket.rzd.ru or tutu.ru for trains, the airline's site for flights, ostrovok.ru for hotels), with the dates, the route and their saved preferences in the task (for example «в поезде только нижняя полка»). It needs no card and no approval: the run searches, picks the best fit and reports it with its price. Do not hand the person a timetable link instead of that search.";

function formatResults(results: readonly WebSearchResult[]) {
  return results
    .map((result, index) => {
      const heading = `${String(index + 1)}. ${result.title}\n${result.url}`;
      return result.snippet ? `${heading}\n${result.snippet}` : heading;
    })
    .join("\n\n");
}

/**
 * eve's `web_search` is provider-managed: an AI Gateway model searches through
 * Exa, and a direct-provider model is handed that provider's native search
 * tool. OpenRouter has neither, so eve emits the gateway tool as
 * `type: "gateway:exa_search"` into a chat-completions body that accepts only
 * `type: "function"`, and every turn fails validation. When OpenRouter owns
 * inference the agent therefore gets an ordinary function tool of our own.
 *
 * The choice is made once, at module load: eve rejects a provider-managed
 * definition returned from a dynamic resolver, which may only return
 * `defineTool()` values. `OPENROUTER_API_KEY` is present in the build
 * environment, so this is the same decision the runtime would make.
 *
 * The OpenRouter tool is ours, so it is withheld from Bro's own mail checks
 * and from report turns: a search query could carry what an untrusted email
 * asked it to. The gateway tool is provider-managed and cannot be gated per
 * mode.
 */
export default openRouterActive()
  ? defineDynamic({
      events: {
        "turn.started": (_event, context) =>
          resolveModeValue(context, {
            interactive: { web_search: openRouterWebSearch },
            "scheduled-worker": { web_search: openRouterWebSearch },
          }),
      },
    })
  : defaultWebSearch;
