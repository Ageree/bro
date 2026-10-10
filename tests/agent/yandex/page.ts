import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { DOMParser } from "linkedom";
import { z } from "zod";
import {
  type JsonValue,
  type YandexOperation,
  operationAnswerSchema,
} from "@agent/lib/yandex/operations";

/** A request the operation's page makes, as the fake service sees it. */
export interface PageRequest {
  readonly body: string;
  readonly method: string;
  readonly path: string;
}

/** What the fake service answers: the status, the url it lands on, the body. */
export interface PageReply {
  readonly body: string;
  readonly status?: number;
  readonly url?: string;
}

/**
 * Run an operation's `run` the way the browser does: in a fresh vm context
 * with the page's `window`, `fetch`, `setTimeout` and `DOMParser`, and no
 * other host object. The service is a function from the request to a reply;
 * sleeps are skipped, so a pause between two calls costs nothing here.
 */
export async function runOnPage(
  operation: YandexOperation,
  args: JsonValue,
  service: (request: PageRequest) => PageReply | undefined
) {
  const requests: PageRequest[] = [];
  const context = createContext({
    DOMParser,
    URL,
    fetch: async (
      input: string,
      init?: { readonly body?: string; readonly method?: string }
    ) => {
      const url = new URL(input, "https://market.yandex.ru/");
      const request = {
        body: init?.body ?? "",
        method: init?.method ?? "GET",
        path: url.pathname + url.search,
      };
      requests.push(request);
      const reply = service(request) ?? { body: "", status: 404 };
      const status = reply.status ?? 200;
      const finalUrl = reply.url ?? url.href;
      return {
        json: async () => z.json().parse(JSON.parse(reply.body)),
        ok: status >= 200 && status < 300,
        status,
        text: async () => reply.body,
        url: finalUrl,
      };
    },
    setTimeout: (callback: () => void) => {
      callback();
      return 0;
    },
    window: {
      state: {
        user: { sk: "u00000000000000000000000000000000", uid: "1000000001" },
      },
    },
  });
  const run = z
    .function({ input: [z.json()] })
    .parse(runInContext(`(${operation.run})`, context));
  const answer = z.json().parse(await run(args));
  return { answer, requests };
}

/** A fixture of the set, as the file has it. */
export function fixtureText(name: string) {
  return readFileSync(
    new URL(`../../fixtures/yandex/market/${name}`, import.meta.url),
    "utf8"
  );
}

/** A fixture of the set, parsed: a page fixture keeps its pages as strings. */
export function fixture(name: string) {
  return z.record(z.string(), z.json()).parse(JSON.parse(fixtureText(name)));
}

/** One page of a page fixture: its HTML, or a variant under another key. */
export function fixturePage(name: string, key = "html") {
  return z.string().parse(fixture(name)[key] ?? "");
}

/**
 * The data of a call that answers `ok`: the operation's own result, checked
 * against its schema. A call that answers anything else throws with that
 * answer's status, so a test reads the failure by name.
 */
export async function okData<Result extends z.ZodType>(
  operation: YandexOperation & { readonly result: Result },
  args: JsonValue,
  service: (request: PageRequest) => PageReply | undefined
) {
  const { answer, requests } = await runOnPage(operation, args, service);
  const parsed = operationAnswerSchema.parse(answer);
  if (parsed.status !== "ok") throw new Error(parsed.status);
  return { data: operation.result.parse(parsed.data), requests };
}

/** The state a signed-in page carries: a page without it reads as signed out. */
export const signedInState =
  '<script>window.state = {"user":{"sk":"u00000000000000000000000000000000","uid":"1000000001","login":"test-user"}};</script>';
