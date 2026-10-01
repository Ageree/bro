import type { RouteHandlerArgs } from "eve/channels";
import { describe, expect, it } from "vitest";
import sandboxChannel from "@agent/channels/sandbox";

/** The routes of a deployment without the code sandbox's key. */
async function answer(
  method: "GET" | "POST",
  url: string,
  params: Readonly<Record<string, string>>,
  headers: Readonly<Record<string, string>> = {}
) {
  const route = sandboxChannel.routes.find(
    (candidate) =>
      candidate.transport !== "websocket" && candidate.method === method
  );
  if (!route || route.transport === "websocket") {
    throw new Error(`Expected the ${method} route.`);
  }
  return await route.handler(
    method === "POST"
      ? new Request(url, { body: "{}", headers, method: "POST" })
      : new Request(url, { headers }),
    routeContext(params)
  );
}

describe("the sandbox channel without the sandbox configured", () => {
  it("refuses the tool router with 401, whatever token comes", async () => {
    const response = await answer(
      "POST",
      "https://bro.example.test/eve/v1/sandbox-tools",
      {},
      { authorization: "Bearer v1.e30.c2ln" }
    );
    expect(response.status).toBe(401);
  });

  it("answers a shared file's link with 404, a malformed one too", async () => {
    const id = "0123456789abcdef01234567";
    for (const name of ["%", "%zz", "report.pdf"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each link is its own request.
      const response = await answer(
        "GET",
        `https://bro.example.test/eve/v1/sandbox-files/${id}/${name}?sig=x`,
        { id, name }
      );
      expect({ name, status: response.status }).toEqual({ name, status: 404 });
    }
  });
});

function routeContext(params: Readonly<Record<string, string>>) {
  return {
    attachSession: unexpected,
    from: unexpected,
    params,
    requestIp: null,
    resolveSession: unexpected,
    to: unexpected,
    waitUntil: unexpected,
  } satisfies RouteHandlerArgs;
}

function unexpected(): never {
  throw new Error("The sandbox routes start no session.");
}
