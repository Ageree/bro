import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { z } from "zod";
import {
  type JsonValue,
  operationAnswerSchema,
} from "@agent/lib/yandex/operations";

/** One response a fake service page gives to a request of its own. */
export interface FakeResponse {
  readonly body: JsonValue;
  readonly status?: number;
}

/** What an operation's function answered, as the transport reads it. */
export type OperationAnswer = z.infer<typeof operationAnswerSchema>;

/**
 * What an operation's `run` sees of its page: the service's answers for the
 * requests it makes (`respond`), and the browser's bits it may read (the
 * `document`'s scripts, IndexedDB). Nothing else of the browser exists here.
 */
export interface FakePage {
  readonly indexedDb?: JsonValue;
  readonly origin: string;
  readonly respond: (
    url: URL,
    init: { readonly body?: string | null; readonly method?: string }
  ) => FakeResponse;
  readonly scripts?: readonly string[];
}

/** A file of the spec's fixtures, read as the answer of a request. */
export async function fixture(path: string): Promise<JsonValue> {
  const text = await readFile(
    new URL(`../../fixtures/yandex/${path}`, import.meta.url),
    "utf8"
  );
  return z.json().parse(JSON.parse(text));
}

/** The data of an `ok` answer; a test that calls it expects one. */
export function dataOf(answer: OperationAnswer): JsonValue {
  if (answer.status !== "ok") {
    throw new Error(`Expected data, got ${answer.status}.`);
  }
  return answer.data;
}

interface FakeRequest<Result> {
  onerror?: () => void;
  onsuccess?: () => void;
  result?: Result;
}

function fakeIndexedDb(value: JsonValue | undefined) {
  return {
    open() {
      const request: FakeRequest<{
        transaction: () => {
          objectStore: () => { get: () => FakeRequest<JsonValue | undefined> };
        };
      }> = {};
      request.result = {
        transaction: () => ({
          objectStore: () => ({
            get: () => {
              const read: FakeRequest<JsonValue | undefined> = {
                result: value,
              };
              queueMicrotask(() => read.onsuccess?.());
              return read;
            },
          }),
        }),
      };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  };
}

/**
 * Run an operation's `run` source as the page would: in a fresh V8 context
 * with only the browser parts it reads, its `fetch` answering from the page.
 * Relative requests resolve against the operation's origin, as in a tab. The
 * answer is parsed as the transport parses it, so a shape the tool would
 * refuse fails here too.
 */
export async function runInPage(
  source: string,
  argument: JsonValue,
  page: FakePage
): Promise<OperationAnswer> {
  const context = createContext({
    console,
    document: {
      scripts: (page.scripts ?? []).map((textContent) => ({
        textContent,
        type: "application/json",
      })),
    },
    fetch: async (
      input: string,
      init?: { body?: string | null; method?: string }
    ) => {
      const response = page.respond(new URL(input, page.origin), {
        body: init?.body,
        method: init?.method,
      });
      return {
        json: async () => response.body,
        status: response.status ?? 200,
        text: async () => JSON.stringify(response.body),
      };
    },
    indexedDB: fakeIndexedDb(page.indexedDb),
    navigator: { userAgent: "Mozilla/5.0 (test)" },
    setTimeout: (callback: () => void) => {
      queueMicrotask(callback);
    },
    TextEncoder,
    URL,
  });
  const answer: unknown = await runInContext(
    `(${source})(${JSON.stringify(argument)})`,
    context
  );
  return operationAnswerSchema.parse(answer);
}
