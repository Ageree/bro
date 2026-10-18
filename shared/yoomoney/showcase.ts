import * as z from "zod";
import { YoomoneyError, yoomoneyOrigin } from "./api";

/**
 * YooMoney's catalogue of services a wallet pays (mobile operators, utility
 * companies, internet providers…): a search, then each service's form,
 * filled in one or more steps. GET `/api/showcase/<id>` answers 300 with the
 * first form, and the form's fields with its hidden ones go by POST to the
 * `Location` it names: 300 is the next form, 400 the same form with the
 * fields' errors, 200 the parameters of `request-payment`. No token: the
 * catalogue is public, the payment is not.
 */

const optionSchema = z.object({
  label: z.string().optional(),
  value: z.coerce.string(),
  get group(): z.ZodOptional<z.ZodArray<typeof itemSchema>> {
    return z.array(itemSchema).optional();
  },
});

const itemSchema = z.object({
  type: z.string(),
  name: z.string().optional(),
  label: z.string().optional(),
  hint: z.string().optional(),
  alert: z.string().optional(),
  required: z.boolean().optional(),
  readonly: z.boolean().optional(),
  value: z.coerce.string().optional(),
  // A month's bounds are periods: «P3Y/now».
  min: z.union([z.number(), z.string()]).optional(),
  max: z.union([z.number(), z.string()]).optional(),
  pattern: z.string().optional(),
  options: z.array(optionSchema).optional(),
  get items(): z.ZodOptional<z.ZodArray<typeof itemSchema>> {
    return z.array(itemSchema).optional();
  },
});

const formSchema = z.object({
  title: z.string().optional(),
  hidden_fields: z.record(z.string(), z.coerce.string()).default({}),
  form: z.array(itemSchema).default([]),
  error: z
    .array(z.object({ name: z.string(), alert: z.string().optional() }))
    .optional(),
});

const paramsSchema = z.object({
  params: z.record(z.string(), z.coerce.string()),
});

const searchSchema = z.object({
  result: z
    .array(
      z.object({
        id: z.coerce.string(),
        title: z.string(),
        url: z.string().nullable().optional(),
      })
    )
    .default([]),
});

/** The input types that are layout or a button, not a value. */
const layoutTypes = new Set(["group", "submit", "paragraph"]);

/** One field of a service's form, as Bro tells the model of it. */
interface ServiceField {
  readonly name: string;
  readonly label: string;
  readonly type: string;
  readonly required: boolean;
  readonly hint?: string;
  readonly value?: string;
  readonly min?: number | string;
  readonly max?: number | string;
  readonly pattern?: string;
  readonly options?: readonly { label: string; value: string }[];
}

/**
 * The fields a form asks for now: groups flattened, and of a select's
 * options only the chosen one's group, by the value given or set.
 */
function formFields(
  items: readonly z.output<typeof itemSchema>[],
  given: ReadonlyMap<string, string>
): ServiceField[] {
  return items.flatMap((item) => {
    const nested = formFields(item.items ?? [], given);
    if (layoutTypes.has(item.type) || item.name === undefined) return nested;
    const value = given.get(item.name) ?? item.value;
    const chosen = item.options?.find((option) => option.value === value);
    const field: ServiceField = {
      name: item.name,
      label: item.label ?? item.name,
      type: item.type,
      required: item.required === true && item.readonly !== true,
      hint: item.hint ?? item.alert,
      value: item.value,
      min: item.min,
      max: item.max,
      pattern: item.pattern,
      options: item.options?.map((option) => ({
        label: option.label ?? option.value,
        value: option.value,
      })),
    };
    return [field, ...nested, ...formFields(chosen?.group ?? [], given)];
  });
}

/**
 * A value the form set itself, which stands unless given: not an empty one,
 * nor a sum of zero (a payment's sum comes as «0.00»).
 */
function preset(field: ServiceField) {
  return (
    field.value !== undefined &&
    field.value !== "" &&
    !(field.type === "amount" && Number(field.value) === 0)
  );
}

/** What the person reads of a filled field: its label and value. */
function shownValue(field: ServiceField, value: string) {
  const option = field.options?.find((choice) => choice.value === value);
  return { label: field.label, value: option?.label ?? value };
}

async function catalogue(url: URL, body?: URLSearchParams) {
  try {
    return await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Accept-Language": "ru",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
      cache: "no-store",
    });
  } catch {
    throw new YoomoneyError("unavailable");
  }
}

/** A step's address, only on the catalogue itself. */
function stepUrl(location: string | null) {
  const url = URL.parse(location ?? "");
  return url?.origin === yoomoneyOrigin &&
    url.pathname.startsWith("/api/showcase/")
    ? url
    : undefined;
}

/** Services of the catalogue by name: «МТС», «Ростелеком», «ЖКХ Тверь». */
export async function searchYoomoneyServices(query: string) {
  const url = new URL("/api/showcase-search", yoomoneyOrigin);
  url.searchParams.set("query", query);
  url.searchParams.set("records", "10");
  let response = await catalogue(url).catch(() => undefined);
  // The search drops a connection now and then; once more is enough.
  response ??= await catalogue(url);
  if (!response.ok) throw new YoomoneyError("unavailable");
  const parsed = searchSchema.safeParse(await response.json().catch(() => ""));
  if (!parsed.success) throw new YoomoneyError("unavailable");
  // A found company paid by its INN opens on a step the API refuses.
  return parsed.data.result
    .filter((service) => !service.url)
    .map((service) => ({ serviceId: service.id, title: service.title }));
}

/**
 * Fills a service's form with the given values, step by step from the
 * first: `fields` when a required value is missing (or `errors` when the
 * service refused one), `ready` with the parameters of the payment and what
 * the person filled in.
 */
export async function fillYoomoneyService(
  serviceId: string,
  values: readonly { readonly name: string; readonly value: string }[]
) {
  const given = new Map(values.map(({ name, value }) => [name, value]));
  const shown = new Map<string, { label: string; value: string }>();
  let title = "";
  let response = await catalogue(
    new URL(`/api/showcase/${encodeURIComponent(serviceId)}`, yoomoneyOrigin)
  );
  for (let step = 0; step < 6; step += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each step reads the previous step's answer.
    const answer: unknown = await response.json().catch(() => undefined);
    if (response.status === 200) {
      const ready = paramsSchema.safeParse(answer);
      if (!ready.success) break;
      return {
        kind: "ready" as const,
        title,
        params: ready.data.params,
        shown: [...shown.values()],
      };
    }
    const form = formSchema.safeParse(answer);
    const next = stepUrl(response.headers.get("location"));
    if (
      (response.status !== 300 && response.status !== 400) ||
      !form.success ||
      next === undefined
    )
      break;
    title = form.data.title ?? title;
    const fields = formFields(form.data.form, given);
    if (response.status === 400) {
      return {
        kind: "fields" as const,
        title,
        fields,
        errors: (form.data.error ?? []).map((error) => ({
          field:
            fields.find((field) => field.name === error.name)?.label ??
            error.name,
          alert: error.alert ?? "",
        })),
      };
    }
    if (
      fields.some(
        (field) => field.required && !given.has(field.name) && !preset(field)
      )
    ) {
      return { kind: "fields" as const, title, fields, errors: [] };
    }
    const body = new URLSearchParams(form.data.hidden_fields);
    for (const field of fields) {
      const value = given.get(field.name) ?? field.value;
      if (value === undefined) continue;
      body.set(field.name, value);
      if (given.has(field.name))
        shown.set(field.name, shownValue(field, value));
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- each step needs the previous step's form.
    response = await catalogue(next, body);
  }
  if (response.status === 404) return { kind: "not_found" as const };
  throw new YoomoneyError("unavailable");
}
