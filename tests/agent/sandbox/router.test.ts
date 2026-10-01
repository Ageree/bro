import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  clearSandboxSettings,
  importWithSandbox,
} from "@tests/helpers/sandbox";

afterEach(() => {
  clearSandboxSettings();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function router() {
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
  });
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
    vi.stubGlobal("fetch", (url: URL) =>
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

  it("keeps the text of a page and drops its markup", async () => {
    const { pageText } = await router();
    expect(pageText("<p>a&nbsp;b</p><!-- c --><div>&#1044;&#x430;</div>")).toBe(
      "a b\nДа"
    );
  });
});
