import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
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
  /** A page's own text, such as its HTML, in place of the body's JSON. */
  readonly text?: string;
}

/** What an operation's function answered, as the transport reads it. */
export type OperationAnswer = z.infer<typeof operationAnswerSchema>;

/**
 * What an operation's `run` sees of its page: the service's answers for the
 * requests it makes (`respond`), and the browser's bits it may read (the
 * `document`'s scripts, IndexedDB). Nothing else of the browser exists here.
 */
export interface FakePage {
  /**
   * The page's IndexedDB database as Chromium has it, kept across runs on
   * the same page and changed by them: `ready`, with the store that holds
   * `indexedDb` (the default); `absent`, never made; `empty`, made without a
   * store. Opening an absent one makes it empty unless the upgrade is called
   * off; a transaction on a missing store throws.
   */
  readonly database?: { state: "absent" | "empty" | "ready" };
  /** Collects the names of the databases the page code deletes. */
  readonly deleted?: string[];
  /** Holds a request before the service answers it, to tell requests that overlap from ones that queue. */
  readonly hold?: (url: URL) => Promise<void>;
  readonly indexedDb?: JsonValue;
  readonly origin: string;
  readonly respond: (
    url: URL,
    init: { readonly body?: string | null; readonly method?: string }
  ) => FakeResponse;
  readonly scripts?: readonly string[];
  /** Collects the delay of every `setTimeout` the page code asks for. */
  readonly timeouts?: number[];
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
  onupgradeneeded?: () => void;
  result?: Result;
  transaction?: { abort: () => void };
}

function fakeIndexedDb(page: FakePage) {
  const database: NonNullable<FakePage["database"]> = page.database ?? {
    state: "ready",
  };
  const store = {
    get: () => {
      const read: FakeRequest<JsonValue | undefined> = {
        result: page.indexedDb,
      };
      queueMicrotask(() => read.onsuccess?.());
      return read;
    },
  };
  const opened = () => ({
    close: () => undefined,
    objectStoreNames: {
      contains: () => database.state === "ready",
      length: database.state === "ready" ? 1 : 0,
    },
    transaction: () => {
      if (database.state !== "ready") {
        throw new Error(
          "NotFoundError: One of the specified object stores was not found."
        );
      }
      return { objectStore: () => store };
    },
  });
  return {
    deleteDatabase(name: string) {
      const request: FakeRequest<undefined> = {};
      page.deleted?.push(name);
      database.state = "absent";
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
    open() {
      const request: FakeRequest<ReturnType<typeof opened>> = {};
      queueMicrotask(() => {
        if (database.state === "absent") {
          const upgrade = { aborted: false };
          request.transaction = {
            abort: () => {
              upgrade.aborted = true;
            },
          };
          request.onupgradeneeded?.();
          if (upgrade.aborted) {
            request.onerror?.();
            return;
          }
          database.state = "empty";
        }
        request.result = opened();
        request.onsuccess?.();
      });
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
    AbortSignal,
    console,
    // The test's clock, faked or not: a context's own Date would read the
    // real day (afisha.prices asked for 23.10 under a clock set to 22.10).
    Date,
    crypto: webcrypto,
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
      await page.hold?.(new URL(input, page.origin));
      const response = page.respond(new URL(input, page.origin), {
        body: init?.body,
        method: init?.method,
      });
      return {
        headers: { get: () => "application/json" },
        json: async () => response.body,
        status: response.status ?? 200,
        text: async () => response.text ?? JSON.stringify(response.body),
      };
    },
    indexedDB: fakeIndexedDb(page),
    navigator: { userAgent: "Mozilla/5.0 (test)" },
    setTimeout: (callback: () => void, ms?: number) => {
      page.timeouts?.push(ms ?? 0);
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

/**
 * A `hold` for a test of requests that must overlap: each held request waits
 * until `count` of them are waiting at once, or a short while, and `overlapped()` says
 * whether they were. Code that sends them one after another never gets there.
 */
export function overlap(match: (url: URL) => boolean, count: number) {
  let waiting = 0;
  let met = false;
  const { promise: together, resolve: release } =
    Promise.withResolvers<undefined>();
  return {
    hold: async (url: URL) => {
      if (!match(url)) return;
      waiting += 1;
      if (waiting >= count) {
        met = true;
        release(undefined);
      }
      await Promise.race([
        together,
        new Promise((done) => {
          setTimeout(done, 100);
        }),
      ]);
      waiting -= 1;
    },
    overlapped: () => met,
  };
}
