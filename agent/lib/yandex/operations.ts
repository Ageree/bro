import { z } from "zod";

const jsonSchema = z.json();

/** Data that crosses the protocol: what arguments and answers are made of. */
export type JsonValue = z.infer<typeof jsonSchema>;

/**
 * What a function of an operation answers, whatever the service: the data
 * the operation's own schema describes, or one of the two walls a Yandex
 * service puts up. A function that sees the service say «not signed in»
 * (401, a redirect to the sign-in) answers `signed_out`; one that meets a
 * check it cannot pass, `captcha`.
 */
export const operationAnswerSchema = z.discriminatedUnion("status", [
  z.object({ data: jsonSchema, status: z.literal("ok") }),
  z.object({ status: z.literal("signed_out") }),
  z.object({ status: z.literal("captcha") }),
]);

/** Yandex's own sites, the only ones an operation may be defined on. */
const yandexHost = /(^|\.)(yandex\.(ru|com|by|kz|net)|ya\.ru)$/u;

export function isYandexHost(host: string) {
  return yandexHost.test(host);
}

/**
 * One call to a Yandex service, fixed by code: the tool does not take a
 * URL, a method or a script from the model, only the operation's id and
 * its arguments.
 *
 * - `origin`: the page the call runs in, so its requests carry the
 *   service's own cookies and tokens. A light page of the service, not its
 *   home page, when there is one.
 * - `run`: the source of an async function `(args) => answer`, written in
 *   code and never composed from anything else. It gets the arguments as
 *   its one parameter, as data, and answers `operationAnswerSchema`. It
 *   must not read cookies (`document.cookie`) or return response headers.
 * - `args`: the shape of the arguments; `result`: the shape of what `run`
 *   answers with `status: "ok"`, which is all the model gets.
 * - `about`: one or two sentences for the model: what the operation does
 *   and what its arguments are. The tool's description lists them all.
 * - `access`: `read` looks, `cart` changes the person's cart and only on a
 *   turn where they asked for it in their own words.
 * - `loaded`: whether the page must have finished loading before `run`
 *   (`complete`, the default) or only parsed (`interactive`).
 */
export function defineYandexOperation<
  const Id extends string,
  Arguments extends z.ZodObject,
  Result extends z.ZodType<JsonValue>,
>(spec: {
  readonly about: string;
  readonly access: "cart" | "purchase" | "read";
  readonly args: Arguments;
  readonly id: Id;
  readonly loaded?: "complete" | "interactive";
  readonly origin: string;
  readonly result: Result;
  readonly run: string;
  readonly service: string;
}) {
  const host = URL.parse(spec.origin)?.hostname;
  if (
    !spec.origin.startsWith("https://") ||
    host === undefined ||
    !isYandexHost(host)
  ) {
    throw new Error(`Operation ${spec.id} is not on a Yandex site.`);
  }
  const named = spec.args.extend({ operation: z.literal(spec.id) });
  // A change of the cart is named by the model as the person's own request
  // of this turn; the tool refuses it outside a turn they wrote.
  const input =
    spec.access === "cart"
      ? named.extend({
          personAskedToChangeCart: z
            .literal(true)
            .describe(
              "true only when the person asked in their own words, in this conversation, to change their cart."
            ),
        })
      : named;
  return { ...spec, input, loaded: spec.loaded ?? "complete" };
}

/** An operation as the registry and the transport hold it. */
export type YandexOperation = ReturnType<
  typeof defineYandexOperation<string, z.ZodObject, z.ZodType<JsonValue>>
>;

/** What the tool is called with: an operation's input, whichever it is. */
export type YandexInput = z.output<YandexOperation["input"]>;

/**
 * The arguments an operation's function is called with: the tool's input
 * without its `operation` and the cart attestation, as the operation's own
 * arguments read it.
 */
export function operationArguments(
  operation: YandexOperation,
  input: YandexInput
): JsonValue {
  return jsonSchema.parse(operation.args.parse(input));
}
