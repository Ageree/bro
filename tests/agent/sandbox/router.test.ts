import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  clearSandboxSettings,
  importWithSandbox,
} from "@tests/helpers/sandbox";

/** The router's own requests, which pin each hop to a checked address. */
const network = vi.hoisted(() => ({
  fetchPublic: vi.fn<(url: URL, init: RequestInit) => Promise<Response>>(),
}));

vi.mock("@agent/lib/sandbox/public-fetch", () => ({
  fetchPublic: network.fetchPublic,
}));

/**
 * Object Storage as the router asks it whether a sandbox holds the person's
 * files: by default no sandbox does.
 */
const storage = vi.hoisted(() => ({
  answer: vi.fn<(url: URL) => Promise<Response>>(),
}));

function noMark() {
  return Promise.resolve(
    new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 })
  );
}

beforeEach(() => {
  storage.answer.mockImplementation(noMark);
  vi.stubGlobal("fetch", async (url: string) => {
    const parsed = new URL(url);
    if (!parsed.pathname.includes("/sandbox/person-files/")) {
      throw new Error(`The router asked ${parsed.pathname} of the web.`);
    }
    return await storage.answer(parsed);
  });
});

afterEach(() => {
  clearSandboxSettings();
  network.fetchPublic.mockReset();
  storage.answer.mockReset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
});

/** A deployment where the person's files reach the task agent. */
const filesPilot = { TASK_FILES_WORKSPACES: "*" };

async function router(overrides: Readonly<Record<string, string>> = {}) {
  return await importWithSandbox(async () => {
    const [{ answerSandboxToolRequest, decodePage, pageText }, keys] =
      await Promise.all([
        import("@agent/lib/sandbox/router"),
        import("@agent/lib/sandbox/keys"),
      ]);
    const token = keys.signSandboxToolsToken({
      sandboxId: "sb-1",
      workspaceId: "personal:abc",
    });
    const ask = async (
      query: string,
      variables?: Readonly<Record<string, z.infer<ReturnType<typeof z.json>>>>,
      bearer = token
    ) =>
      await answerSandboxToolRequest(
        new Request("https://bro.example.test/eve/v1/sandbox-tools", {
          body: JSON.stringify({ query, variables }),
          headers: { authorization: `Bearer ${bearer}` },
          method: "POST",
        })
      );
    return { ask, decodePage, pageText };
  }, overrides);
}

const toolsAnswer = z.object({
  data: z.object({
    tools: z.array(
      z.object({
        inputSchema: z.looseObject({ required: z.array(z.string()) }),
        name: z.string(),
      })
    ),
  }),
});

const executeAnswer = z.object({
  data: z.object({
    toolExecute: z.object({
      error: z.string().nullable(),
      ok: z.boolean(),
      output: z.json(),
    }),
  }),
});

async function executed(response: Response) {
  return executeAnswer.parse(await response.json()).data.toolExecute;
}

const execute =
  "mutation($name: String!, $input: JSON!) { toolExecute(name: $name, input: $input) { ok output error } }";

describe("the sandbox tool router", () => {
  it("answers nothing without sandboxd's token", async () => {
    const { ask } = await router();
    const response = await ask("{ tools { name } }", undefined, "v1.x.y");
    expect(response.status).toBe(401);
  });

  it("lists its tools with their input schemas", async () => {
    const { ask } = await router();
    const response = await ask("{ tools { name description inputSchema } }");
    const { tools } = toolsAnswer.parse(await response.json()).data;
    expect(tools.map((tool) => tool.name)).toEqual([
      "web_search",
      "web_fetch",
      "download",
    ]);
    expect(tools[1]?.inputSchema.required).toEqual(["url"]);
  });

  it("refuses unknown tools, bad input and private hosts as tool errors", async () => {
    const { ask } = await router();
    const unknown = await executed(
      await ask(execute, { input: {}, name: "gmail" })
    );
    expect(unknown).toEqual({
      error: "There is no tool gmail.",
      ok: false,
      output: null,
    });
    const invalid = await executed(
      await ask(execute, { input: { address: 1 }, name: "web-fetch" })
    );
    expect(invalid.ok).toBe(false);
    expect(invalid.error).toContain("Invalid input");
    const local = await executed(
      await ask(execute, {
        input: { url: "https://localhost/x" },
        name: "download",
      })
    );
    expect(local.error).toBe("Only public hosts can be fetched.");
  });

  it("reads a page as text and downloads a file as base64", async () => {
    network.fetchPublic.mockImplementation(async (url: URL) =>
      Promise.resolve(
        url.pathname.endsWith(".csv")
          ? new Response("a,b\n1,2\n", {
              headers: { "content-type": "text/csv" },
            })
          : new Response(
              "<html><head><style>p{}</style></head><body><h1>Курс</h1><p>1 &amp; 2</p><script>x()</script></body></html>",
              { headers: { "content-type": "text/html; charset=utf-8" } }
            )
      )
    );
    const { ask } = await router();
    const page = await executed(
      await ask(execute, {
        input: { url: "https://example.com/" },
        name: "web_fetch",
      })
    );
    expect(page.output).toMatchObject({ content: "Курс\n1 & 2" });
    const file = await executed(
      await ask(execute, {
        input: { url: "https://example.com/d/rates.csv" },
        name: "download",
      })
    );
    expect(file.output).toEqual({
      base64: Buffer.from("a,b\n1,2\n").toString("base64"),
      bytes: 8,
      fileName: "rates.csv",
      mediaType: "text/csv",
    });
  });

  it("requests every redirect hop through the checked connection", async () => {
    network.fetchPublic.mockImplementation(async (url: URL) =>
      Promise.resolve(
        url.hostname === "short.example.test"
          ? new Response(null, {
              headers: { location: "https://inner.example.test/admin" },
              status: 302,
            })
          : new Response("ok", { headers: { "content-type": "text/plain" } })
      )
    );
    const { ask } = await router();
    const page = await executed(
      await ask(execute, {
        input: { url: "https://short.example.test/x" },
        name: "web_fetch",
      })
    );
    expect(page.output).toMatchObject({ content: "ok" });
    expect(network.fetchPublic.mock.calls.map(([url]) => url.href)).toEqual([
      "https://short.example.test/x",
      "https://inner.example.test/admin",
    ]);
  });

  it("reads a page in the encoding it names", async () => {
    const { decodePage } = await router();
    const cp1251 = new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);
    expect(decodePage(cp1251, "text/html; charset=windows-1251")).toBe(
      "Привет"
    );
    const meta = new Uint8Array([
      ...new TextEncoder().encode('<meta charset="windows-1251">'),
      ...cp1251,
    ]);
    expect(decodePage(meta, "text/html")).toContain("Привет");
    expect(decodePage(new TextEncoder().encode("ok"), undefined)).toBe("ok");
  });

  it("runs one tool per request, however the query is written", async () => {
    const { ask } = await router();
    const aliased = await ask(
      'mutation { a: toolExecute(name: "download", input: {}) { ok } b: toolExecute(name: "download", input: {}) { ok } }'
    );
    const body = z
      .object({ errors: z.array(z.object({ message: z.string() })) })
      .parse(await aliased.json());
    expect(body.errors[0]?.message).toBe("One toolExecute per request.");
    const fragment = await ask(
      'mutation { ...on Mutation { toolExecute(name: "download", input: {}) { ok } } }'
    );
    expect(await fragment.text()).toContain("Fragments are not supported.");
  });

  it("reads a hostile page in linear time and survives odd entities", async () => {
    const { pageText } = await router();
    // Openers whose `>` is there, but never a closing `</script>`.
    const hostile = "<script>".repeat(200_000);
    const started = performance.now();
    expect(pageText(hostile)).toBe("");
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(pageText("a &#99999999; b &#x110000; c")).toBe(
      "a &#99999999; b &#x110000; c"
    );
  });

  it("keeps the text of a page and drops its markup", async () => {
    const { pageText } = await router();
    expect(pageText("<p>a&nbsp;b</p><!-- c --><div>&#1044;&#x430;</div>")).toBe(
      "a b\nДа"
    );
  });

  it("keeps a sandbox that holds the person's files off the web", async () => {
    storage.answer.mockImplementation((url) =>
      url.pathname.endsWith("/sandbox/person-files/sb-1")
        ? Promise.resolve(new Response("1", { status: 200 }))
        : noMark()
    );
    const { ask } = await router(filesPilot);
    for (const [name, input] of [
      ["web_fetch", { url: "https://example.com/?d=c2VjcmV0" }],
      ["download", { url: "https://example.com/x.csv" }],
      ["web-search", { query: "секрет из таблицы" }],
    ] as const) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each tool is its own case.
      const answer = await executed(await ask(execute, { input, name }));
      expect(answer.ok).toBe(false);
      expect(answer.error).toMatch(/holds the person's files.+no web access/u);
    }
    expect(network.fetchPublic).not.toHaveBeenCalled();
    // The mark it asked for is the one of the token's sandbox.
    expect(
      storage.answer.mock.calls.map(([url]) => url.pathname.split("/").at(-1))
    ).toEqual(["sb-1", "sb-1", "sb-1"]);
  });

  it("asks for no mark without the files pilot", async () => {
    // No sandbox gets the person's files then, and the web does not wait
    // on Object Storage.
    storage.answer.mockResolvedValue(new Response(null, { status: 503 }));
    network.fetchPublic.mockResolvedValue(
      new Response("<p>Привет</p>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    );
    const { ask } = await router();
    const answer = await executed(
      await ask(execute, {
        input: { url: "https://example.com/" },
        name: "web_fetch",
      })
    );

    expect(answer.ok).toBe(true);
    expect(storage.answer).not.toHaveBeenCalled();
  });

  it("refuses the web while the mark cannot be read", async () => {
    vi.useFakeTimers();
    storage.answer.mockResolvedValue(new Response(null, { status: 503 }));
    const { ask } = await router(filesPilot);
    const pending = ask(execute, {
      input: { url: "https://example.com/" },
      name: "web_fetch",
    });
    await vi.advanceTimersByTimeAsync(1000);
    const answer = await executed(await pending);

    expect(answer.ok).toBe(false);
    expect(answer.error).toMatch(/could not be checked/u);
    expect(network.fetchPublic).not.toHaveBeenCalled();
  });
});
