/**
 * Books a salon, a barbershop, a clinic or a studio that takes online
 * bookings through YClients, by its API in seconds: on 23.10 a haircut at
 * the person's own building took the browser 59 steps and four minutes on
 * the same booking form, and twelve more on a second salon.
 *
 * Only in the pilot (YCLIENTS_WORKSPACES, with YCLIENTS_PARTNER_TOKEN), and
 * only in a turn the person's own message opened: a booking is made in
 * their name, with their name and phone, and no worker or report turn makes
 * one. Nothing here logs what the person booked or their contacts.
 */

import { defineDynamic, defineTool, type ToolContext } from "eve/tools";
import { z } from "zod";
import { readOwnPhone } from "@agent/lib/browser-use/facts";
import { personWordsThisTurn } from "@agent/lib/browser-use/said";
import { resolveModeValue } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import {
  type StepIdentity,
  stepIdentity,
  stepStartedEventSchema,
  turnMemory,
} from "@agent/lib/turn-kind/step";
import {
  YclientsError,
  yclientsCall,
  yclientsPilot,
} from "@agent/lib/yclients/api";
import { bookingLinksOf } from "@agent/lib/yclients/links";
import { readUserProfile } from "@db/services/user-profile";

/** Slots are read for this many days of a range at most. */
const maximumSlotDays = 7;
/** How far ahead a range's later free days are looked up. */
const laterDaysAhead = 30;
const maximumServices = 80;
const maximumBranches = 20;

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .describe("A day as YYYY-MM-DD");
const company = z
  .number()
  .int()
  .positive()
  .describe("The YClients company id from find");
const serviceIds = z
  .array(z.number().int().positive())
  .min(1)
  .max(5)
  .describe("Service ids from services");

const inputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("find"),
    link: z
      .string()
      .min(8)
      .max(500)
      .describe(
        "The place's site (its `site` on Yandex Maps), its «Записаться» page or a YClients booking link (…yclients.com)"
      ),
  }),
  z.object({ action: z.literal("services"), company }),
  z.object({ action: z.literal("staff"), company, services: serviceIds }),
  z.object({
    action: z.literal("slots"),
    company,
    from: day,
    services: serviceIds,
    staff: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("A master's id from staff; 0 is any master"),
    to: day
      .optional()
      .describe("The last day, included; the from day alone if left out"),
  }),
  z.object({
    action: z.literal("book"),
    code: z
      .string()
      .max(12)
      .optional()
      .describe(
        "The SMS code the person gave, only after book said one was sent"
      ),
    comment: z.string().max(200).optional(),
    company,
    datetime: z
      .string()
      .min(10)
      .max(40)
      .describe("The slot's datetime exactly as slots gave it"),
    form: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("The booking form id from find, when it gave one"),
    personAskedToBook: z
      .literal(true)
      .describe(
        "The person asked in this turn to book them (not only to look at free times)"
      ),
    services: serviceIds,
    staff: z.number().int().min(0).default(0),
  }),
]);

type Input = z.output<typeof inputSchema>;

const description = `Book a salon, barbershop, nail or beauty studio, clinic, fitness or other studio that takes online bookings through YClients — in seconds, instead of browser_task clicking through its booking form. Steps: find with the place's site (maps.org's site) or its YClients link answers the company (when several branches come back, take the one at the address the person meant); services lists the services with prices and minutes; slots gives the free times on days (staff 0 is any master); staff lists the masters for the services; book books one slot. Book only a time inside what the person asked for — the day, and «закончить до 16:00» counts the service's minutes — at the place they meant, and only once; then tell them the place, service, day, time, master and price in one message. When find finds no YClients booking or a call fails, do the booking with browser_task as before. When book says an SMS code was sent, ask the person for it and call book again with the same arguments and the code.`;

const notThePerson =
  "Nothing was done: bookings through YClients are made only in a turn the person's own message opened. Ask the person.";
const unavailable =
  "YClients did not answer as expected. Try once more, or do the booking with browser_task. Never quote an error text or a status code to the person.";

const bookformSchema = z.object({
  company_id: z.coerce.number().nullish(),
  group_id: z.coerce.number().nullish(),
  phone_confirmation: z.boolean().nullish(),
});

const companiesSchema = z.array(
  z.object({
    address: z.string().nullish(),
    city: z.string().nullish(),
    id: z.coerce.number(),
    title: z.string().nullish(),
  })
);

const servicesSchema = z.object({
  category: z
    .array(z.object({ id: z.coerce.number(), title: z.string() }))
    .nullish(),
  services: z.array(
    z.object({
      category_id: z.coerce.number().nullish(),
      id: z.coerce.number(),
      price_max: z.coerce.number().nullish(),
      price_min: z.coerce.number().nullish(),
      seance_length: z.coerce.number().nullish(),
      title: z.string(),
    })
  ),
});

const staffSchema = z.array(
  z.object({
    bookable: z.boolean().nullish(),
    id: z.coerce.number(),
    name: z.string(),
    specialization: z.string().nullish(),
  })
);

/**
 * YClients writes a moment as ISO 8601 or, in older answers, Unix seconds;
 * either reads as ISO 8601, which the booking takes back.
 */
const momentSchema = z.union([
  z.string(),
  z.number().transform((seconds) => new Date(seconds * 1000).toISOString()),
]);

const datesSchema = z.object({
  booking_dates: z.array(momentSchema).nullish(),
});

const timesSchema = z.array(
  z.object({
    datetime: momentSchema,
    seance_length: z.coerce.number().nullish(),
    time: z.string(),
  })
);

const recordsSchema = z.array(
  z.object({ id: z.coerce.number().nullish(), record_id: z.coerce.number() })
);

/** A length in seconds as whole minutes, or null when YClients gave none. */
function minutesOf(seconds: number | null | undefined) {
  return seconds === null || seconds === undefined
    ? null
    : Math.round(seconds / 60);
}

/** A service's price in roubles: «3000», or «2500–3500» for a range. */
function priceOf(
  low: number | null | undefined,
  high: number | null | undefined
) {
  if (low === null || low === undefined) return null;
  return high === null || high === undefined || high === low
    ? String(low)
    : `${String(low)}–${String(high)}`;
}

function servicesQuery(
  ids: readonly number[],
  extra: Record<string, string> = {}
) {
  const query = new URLSearchParams(extra);
  for (const id of ids) query.append("service_ids[]", String(id));
  return query;
}

/** The days from `from` to `to`, both included, at most `limit` of them. */
function daysBetween(from: string, to: string, limit: number) {
  const days: string[] = [];
  for (
    let at = Date.parse(`${from}T00:00:00Z`);
    at <= Date.parse(`${to}T00:00:00Z`) && days.length < limit;
    at += 86_400_000
  ) {
    days.push(new Date(at).toISOString().slice(0, 10));
  }
  return days;
}

/**
 * A Russian phone as YClients takes it, 79161502239: «8 916…», «+7 916…» and
 * ten digits starting with 9 are all +7. Another country's number goes as
 * its digits.
 */
export function yclientsPhone(phone: string) {
  const digits = phone.replaceAll(/\D/gu, "");
  if (digits.length === 11 && digits.startsWith("8"))
    return `7${digits.slice(1)}`;
  if (digits.length === 10 && digits.startsWith("9")) return `7${digits}`;
  return digits.length >= 10 ? digits : undefined;
}

/** A place `find` answers with, from its company and what named it. */
function placeOf(
  companyId: number,
  row: z.infer<typeof companiesSchema>[number] | undefined,
  form: number | undefined,
  phoneConfirmation: boolean | undefined
) {
  return {
    address: [row?.city, row?.address].filter(Boolean).join(", ") || null,
    company: companyId,
    form: form ?? null,
    phoneConfirmation: phoneConfirmation ?? null,
    title: row?.title ?? null,
  };
}

async function find(link: string, signal: AbortSignal) {
  const url = URL.parse(/^https?:\/\//iu.test(link) ? link : `https://${link}`);
  if (url === null) {
    return {
      ok: false as const,
      reply: "That is not a link. Pass the place's site or its booking link.",
    };
  }
  const found = await bookingLinksOf(url);
  if (found.kind === "unreachable" || found.links.length === 0) {
    return {
      ok: false as const,
      reply:
        found.kind === "unreachable"
          ? "The page did not open. Do the booking with browser_task."
          : "No YClients booking was found there: the place books some other way. Do the booking with browser_task (its site or the «Записаться» button of its Yandex Maps card).",
    };
  }
  // A form's company, or for a network's form (`group_id`) every branch of
  // the network: its `company_id` is only the form's default branch, and
  // the person may mean another one (developers.yclients.com, bookform).
  const companies = new Map<
    number,
    { form?: number; phoneConfirmation?: boolean }
  >();
  const groups = new Map<number, number>();
  // Up to five links: their forms are read together.
  const forms = await Promise.all(
    found.links.map(async (one) =>
      one.form === undefined
        ? undefined
        : bookformSchema.parse(
            await yclientsCall("GET", `/bookform/${String(one.form)}`, {
              signal,
            })
          )
    )
  );
  for (const [index, one] of found.links.entries()) {
    const form = forms[index];
    const group = form?.group_id ?? 0;
    // A network's form says nothing of SMS: each branch has its own setting.
    const phoneConfirmation =
      group > 0 ? undefined : (form?.phone_confirmation ?? undefined);
    if (one.company !== undefined) {
      companies.set(one.company, { form: one.form, phoneConfirmation });
    } else if (group > 0 && one.form !== undefined) {
      groups.set(group, one.form);
    } else if ((form?.company_id ?? 0) > 0) {
      companies.set(form?.company_id ?? 0, {
        form: one.form,
        phoneConfirmation,
      });
    }
  }
  const branches = (
    await Promise.all(
      [...groups].map(async ([group, form]) =>
        companiesSchema
          .parse(
            await yclientsCall("GET", "/companies", {
              query: new URLSearchParams({
                active: "1",
                group_id: String(group),
              }),
              signal,
            })
          )
          // A branch's own SMS setting is not in the list: book finds out.
          .map((branch) => placeOf(branch.id, branch, form, undefined))
      )
    )
  ).flat();
  const known = await Promise.all(
    [...companies].map(async ([id, from]) => {
      const rows = companiesSchema.safeParse(
        await yclientsCall("GET", "/companies", {
          query: new URLSearchParams({ id: String(id) }),
          signal,
        }).catch(() => [])
      );
      const row = rows.success ? rows.data[0] : undefined;
      return placeOf(id, row, from.form, from.phoneConfirmation);
    })
  );
  const all = [...known, ...branches];
  const places = all.slice(0, maximumBranches);
  return {
    ok: true as const,
    places,
    // The model hears that the list is cut, and can name the address.
    total: all.length,
  };
}

async function services(companyId: number, signal: AbortSignal) {
  const found = servicesSchema.parse(
    await yclientsCall("GET", `/book_services/${String(companyId)}`, { signal })
  );
  const categories = new Map(
    (found.category ?? []).map((one) => [one.id, one.title])
  );
  return {
    ok: true as const,
    services: found.services.slice(0, maximumServices).map((one) => ({
      category: categories.get(one.category_id ?? 0) ?? null,
      id: one.id,
      minutes: minutesOf(one.seance_length),
      priceRub: priceOf(one.price_min, one.price_max),
      title: one.title,
    })),
    total: found.services.length,
  };
}

async function staff(
  companyId: number,
  ids: readonly number[],
  signal: AbortSignal
) {
  const found = staffSchema.parse(
    await yclientsCall("GET", `/book_staff/${String(companyId)}`, {
      query: servicesQuery(ids),
      signal,
    })
  );
  return {
    ok: true as const,
    staff: found
      .filter((one) => one.bookable !== false)
      .map((one) => ({
        id: one.id,
        name: one.name,
        specialization: one.specialization ?? null,
      })),
  };
}

async function slots(
  input: Extract<Input, { action: "slots" }>,
  signal: AbortSignal
) {
  const to =
    input.to === undefined || input.to < input.from ? input.from : input.to;
  const ahead = new Date(
    Date.parse(`${input.from}T00:00:00Z`) + laterDaysAhead * 86_400_000
  )
    .toISOString()
    .slice(0, 10);
  const dates = datesSchema.parse(
    await yclientsCall("GET", `/book_dates/${String(input.company)}`, {
      query: servicesQuery(input.services, {
        date_from: input.from,
        date_to: ahead > to ? ahead : to,
        staff_id: String(input.staff),
      }),
      signal,
    })
  );
  const open = new Set(
    (dates.booking_dates ?? []).map((moment) => moment.slice(0, 10))
  );
  const read = daysBetween(input.from, to, maximumSlotDays);
  // A range longer than the days read: the rest counts as later days.
  const readThrough = read.at(-1) ?? input.from;
  const asked = read.filter((one) => open.has(one));
  const days = await Promise.all(
    asked.map(async (date) => {
      const times = timesSchema.parse(
        await yclientsCall(
          "GET",
          `/book_times/${String(input.company)}/${String(input.staff)}/${date}`,
          { query: servicesQuery(input.services), signal }
        )
      );
      return {
        date,
        times: times.map((one) => ({
          datetime: one.datetime,
          minutes: minutesOf(one.seance_length),
          time: one.time,
        })),
      };
    })
  );
  return {
    days: days.filter((one) => one.times.length > 0),
    readThrough,
    laterDays: [...open]
      .filter((one) => one > readThrough)
      .toSorted()
      .slice(0, 5),
    ok: true as const,
  };
}

/** What a refused booking's codes mean, for the model (developers.yclients.com). */
function refusal(codes: readonly number[]) {
  if (codes.includes(432)) {
    return "The SMS code is wrong. Ask the person to check it, then call book again with the right code.";
  }
  if (codes.includes(433) || codes.includes(437)) {
    return "That time has just been taken. Read slots again and take another time inside what the person asked for, or tell them none is left.";
  }
  if (codes.includes(434)) {
    return "This place does not take online bookings from the person's phone. Offer to call the place instead.";
  }
  if (codes.includes(431)) {
    return "YClients did not take the person's phone number. Ask the person for their phone number, save it with personal_info__update, then book.";
  }
  if (codes.includes(435)) {
    return "YClients needs the person's name. Ask for it, save it with personal_info__update, then book.";
  }
  if (codes.includes(436)) {
    return "No master is free for that time. Read slots again for another time.";
  }
  if (codes.includes(438)) {
    return "That service can no longer be booked. Read services again.";
  }
  return "YClients refused the booking. Do it with browser_task on the place's booking page, or offer to call the place. Never quote an error text or a status code to the person.";
}

/**
 * A booking per turn: claimed before the first await, so two calls of one
 * step cannot both book, and given back only when YClients surely booked
 * nothing. Keyed by the turn and the person's words: after eve hands a
 * session over, turn ids start again at `turn_0`. On this instance only: a
 * restart of eve between `book_record` and the end of its step could run
 * the step, and the booking, again.
 */
const bookingClaims = turnMemory<"booked" | "claimed" | "open">();

/** The step a booking is claimed under, or undefined without a turn id. */
function claimOf(words: {
  readonly said: readonly string[] | null;
  readonly step: StepIdentity;
}) {
  if (words.step.turnId === undefined) return undefined;
  return {
    sessionId: words.step.sessionId,
    turnId: `${words.step.turnId}\n${(words.said ?? []).join("\n")}`,
  };
}

/**
 * Whether the person's own words of the turn hold the code as a number of
 * its own («код 4821», «4 8 2 1»), not as a part of another one: «в 11:00»
 * does not give the code 1100.
 */
function saidCode(said: readonly string[] | null, code: string) {
  return (said ?? []).some((words) =>
    (words.match(/\d(?:[\s-]?\d){3,9}/gu) ?? []).some(
      (number) => number.replaceAll(/\D/gu, "") === code
    )
  );
}

/** Whether YClients surely refused: a 4xx with its own error codes. */
function refusedForSure(error: YclientsError) {
  return error.status >= 400 && error.status < 500 && error.codes.length > 0;
}

async function book(
  input: Extract<Input, { action: "book" }>,
  context: ToolContext,
  words: {
    readonly said: readonly string[] | null;
    readonly step: StepIdentity;
  }
) {
  const claim = claimOf(words);
  if (claim === undefined) return { ok: false as const, reply: notThePerson };
  const held = bookingClaims.get(claim);
  if (held === "booked" || held === "claimed") {
    return {
      ok: false as const,
      reply:
        "One booking was already made in this turn. Do not book again unless the person asks for another one.",
    };
  }
  const digits = input.code?.replaceAll(/\D/gu, "") ?? "";
  const code = digits === "" ? undefined : digits;
  if (code !== undefined && !saidCode(words.said, code)) {
    return {
      ok: false as const,
      reply:
        "That code is not in the person's own words of this turn. Ask the person for the SMS code.",
    };
  }
  const caller = context.session.auth.current;
  if (caller?.principalType !== "user")
    return { ok: false as const, reply: notThePerson };
  bookingClaims.set(claim, "claimed");
  try {
    const result = await bookOnce(
      input,
      code,
      scopeFromPrincipal(caller),
      context.abortSignal
    );
    bookingClaims.set(claim, result.booked ? "booked" : "open");
    return result;
  } catch (error) {
    // Before `book_record`, or refused by it for sure, nothing was booked.
    if (error instanceof BookingSent) {
      bookingClaims.set(claim, "booked");
      console.warn("[yclients] booking answer lost", {
        company: input.company,
        status: error.status,
      });
      return {
        ok: false as const,
        reply:
          "It is unknown whether the booking went through: the answer was lost. Do not book again. Tell the person to check for the salon's SMS, and offer to call the place to check.",
      };
    }
    bookingClaims.set(claim, "open");
    throw error;
  }
}

/**
 * A `book_record` that went out and came back with no sure refusal: a
 * network error, a 5xx or an answer that is no envelope. The booking may
 * exist, so it is never sent again (dev-notes: a 5xx can come after the
 * order exists).
 */
class BookingSent extends Error {
  override readonly name = "BookingSent";

  constructor(readonly status: number | null) {
    super("The booking may exist.");
  }
}

async function bookOnce(
  input: Extract<Input, { action: "book" }>,
  code: string | undefined,
  scope: ReturnType<typeof scopeFromPrincipal>,
  signal: AbortSignal
) {
  const [profile, ownPhone] = await Promise.all([
    readUserProfile(scope),
    readOwnPhone(scope),
  ]);
  const fullname = [profile.firstName, profile.lastName]
    .filter(Boolean)
    .join(" ");
  if (fullname === "") {
    return {
      booked: false,
      ok: false as const,
      reply:
        "The salon needs the person's name. Ask for it, save it with personal_info__update, then book.",
    };
  }
  const phone = ownPhone === undefined ? undefined : yclientsPhone(ownPhone);
  if (phone === undefined) {
    return {
      booked: false,
      ok: false as const,
      reply:
        "The salon needs the person's phone number. Ask for it, save it with personal_info__update, then book.",
    };
  }
  const sendCode = async () => {
    await yclientsCall("POST", `/book_code/${String(input.company)}`, {
      body: { fullname, phone },
      signal,
    });
    return {
      booked: false,
      codeSent: true,
      ok: true as const,
      reply:
        "YClients sent an SMS code to the person's phone. Ask them for it, then call book again with the same arguments and the code. Nothing is booked yet.",
    };
  };
  if (code === undefined && input.form !== undefined && input.form > 0) {
    const form = bookformSchema.parse(
      await yclientsCall("GET", `/bookform/${String(input.form)}`, { signal })
    );
    // A network's form leaves SMS to each branch: book_record says so (432).
    if ((form.group_id ?? 0) === 0 && form.phone_confirmation === true) {
      return sendCode();
    }
  }
  const appointments = [
    {
      datetime: input.datetime,
      id: 1,
      services: input.services,
      staff_id: input.staff,
    },
  ];
  await yclientsCall("POST", `/book_check/${String(input.company)}`, {
    body: { appointments },
    signal,
  });
  const comment = input.comment?.trim() ?? "";
  // The code and the comment go only when there is one.
  const optional = new Map<string, string>();
  if (code !== undefined) optional.set("code", code);
  if (comment !== "") optional.set("comment", comment);
  const recordBody = {
    appointments,
    email: profile.email ?? "",
    fullname,
    phone,
    ...Object.fromEntries(optional),
  };
  let answer: z.core.util.JSONType;
  try {
    answer = await yclientsCall(
      "POST",
      `/book_record/${String(input.company)}`,
      {
        body: recordBody,
        signal,
      }
    );
  } catch (error) {
    if (!(error instanceof YclientsError) || !refusedForSure(error)) {
      throw new BookingSent(
        error instanceof YclientsError ? error.status : null
      );
    }
    // No code was given and the salon wants one: it goes out now.
    if (code === undefined && error.codes.includes(432)) return sendCode();
    throw error;
  }
  const records = recordsSchema.safeParse(answer);
  console.info("[yclients] booked", {
    company: input.company,
    records: records.success ? records.data.length : null,
  });
  return {
    booked: true,
    datetime: input.datetime,
    ok: true as const,
    recordIds: records.success ? records.data.map((one) => one.record_id) : [],
    reply:
      "Booked. Tell the person the place, the service, the day and time, the master and the price in one message; the salon sends its own SMS. Add it to the calendar only if they ask.",
  };
}

async function callYclients(
  input: Input,
  context: ToolContext,
  words: {
    readonly said: readonly string[] | null;
    readonly step: StepIdentity;
  }
) {
  const signal = context.abortSignal;
  try {
    if (input.action === "find") return await find(input.link, signal);
    if (input.action === "services") {
      return await services(input.company, signal);
    }
    if (input.action === "staff") {
      return await staff(input.company, input.services, signal);
    }
    if (input.action === "slots") return await slots(input, signal);
    return await book(input, context, words);
  } catch (error) {
    if (signal.aborted) throw error;
    console.warn("[yclients] call failed", {
      action: input.action,
      codes: error instanceof YclientsError ? error.codes : undefined,
      error: error instanceof Error ? error.name : null,
      status: error instanceof YclientsError ? error.status : undefined,
    });
    return {
      ok: false as const,
      reply:
        error instanceof YclientsError && input.action === "book"
          ? refusal(error.codes)
          : unavailable,
    };
  }
}

export default defineDynamic({
  events: {
    "step.started": (event, context) => {
      const auth = context.session.auth.current;
      if (resolveModeValue(context, { interactive: true }) !== true)
        return null;
      if (auth?.principalType !== "user") return null;
      const scope = scopeFromPrincipal(auth);
      if (!yclientsPilot(scope)) return null;
      const rootSessionId = context.session.id;
      const step = stepIdentity(
        stepStartedEventSchema.safeParse(event).data,
        context.session.id
      );
      const turn = personWordsThisTurn(context.messages, step);
      const words = { said: turn.said, step };
      return {
        yclients: defineTool({
          availableInSubagents: false,
          description,
          inputSchema,
          async execute(input, toolContext) {
            const current = toolContext.session.auth.current;
            if (
              current?.principalType !== "user" ||
              toolContext.session.id !== rootSessionId ||
              toolContext.session.parent != null
            ) {
              return { ok: false as const, reply: notThePerson };
            }
            const currentScope = scopeFromPrincipal(current);
            if (
              currentScope.userId !== scope.userId ||
              currentScope.workspaceId !== scope.workspaceId
            ) {
              return { ok: false as const, reply: notThePerson };
            }
            if (input.action === "book" && words.said === null) {
              return { ok: false as const, reply: notThePerson };
            }
            return callYclients(input, toolContext, words);
          },
        }),
      };
    },
  },
});
