import { readFileSync } from "node:fs";
import vm from "node:vm";
import { expect } from "vitest";
import { z } from "zod";
import {
  type JsonValue,
  type YandexOperation,
  operationAnswerSchema,
} from "@agent/lib/yandex/operations";

const json = z.json();

/** Recorded answers, with values made up and the structure real. */
export function fixture(name: string) {
  const file = new URL(
    `../../../fixtures/yandex/food/${name}.json`,
    import.meta.url
  );
  return json.parse(JSON.parse(readFileSync(file, "utf8")));
}

/** The globals a page has: its props and its query state. */
export const pageGlobals = z.record(z.string(), json);

export interface Route {
  readonly body: JsonValue;
  readonly path: string;
  readonly status?: number;
}

/**
 * The page a function runs in: a fetch that answers from the routes by
 * path, the page's globals, and a timer that fires at once. Nothing else of
 * a browser is there.
 */
export function page(
  routes: readonly Route[],
  globals: z.infer<typeof pageGlobals> = {}
) {
  const fetch = async (input: string) => {
    const path = new URL(input, "https://page.test/").pathname;
    const route = routes.find((candidate) => candidate.path === path);
    if (route === undefined) throw new Error(`no route for ${path}`);
    return {
      headers: { get: () => "application/json" },
      json: async () => route.body,
      status: route.status ?? 200,
    };
  };
  return vm.createContext({
    fetch,
    setTimeout: (done: () => void) => {
      done();
    },
    window: globals,
  });
}

/** The answer of an operation's function, run in the page with its arguments. */
export async function reply(
  operation: YandexOperation,
  context: vm.Context,
  args: JsonValue = {}
) {
  const fn = z
    .function({ input: [json], output: z.promise(json) })
    .parse(vm.runInContext(`(${operation.run})`, context));
  const copied: unknown = JSON.parse(JSON.stringify(await fn(args)));
  return operationAnswerSchema.parse(copied);
}

/** The data of an ok answer, which must fit the operation's result schema. */
export async function dataOf(
  operation: YandexOperation,
  context: vm.Context,
  args: JsonValue = {}
) {
  const answer = await reply(operation, context, args);
  expect(answer.status).toBe("ok");
  if (answer.status !== "ok") throw new Error("not ok");
  return operation.result.parse(answer.data);
}
