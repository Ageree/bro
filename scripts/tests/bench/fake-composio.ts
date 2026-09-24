import { z } from "zod";

/**
 * Composio's REST API with Google behind its proxy, as far as fixtures use
 * it: connected accounts, and Gmail, Calendar and Drive calls answered the
 * way the proxy answers — HTTP 200 with Google's own status and body inside.
 * Installed as `fetch`; every proxied call is kept for the assertions.
 */

const proxyBodySchema = z.object({
  binary_body: z
    .object({ base64: z.string(), content_type: z.string() })
    .optional(),
  body: z.looseObject({}).optional(),
  connected_account_id: z.string(),
  endpoint: z.url(),
  method: z.enum(["DELETE", "GET", "PATCH", "POST"]),
  parameters: z.array(
    z.object({ name: z.string(), type: z.literal("query"), value: z.string() })
  ),
});

export type ProxyCall = z.infer<typeof proxyBodySchema>;

const insertSchema = z.object({
  labelIds: z.array(z.string()),
  raw: z.string(),
  threadId: z.string().optional(),
});

const eventSchema = z.looseObject({ summary: z.string() });

/** A JSON answer; `JSON.stringify` of what Composio would send. */
const json = (text: string, status = 200) =>
  new Response(text, {
    headers: { "content-type": "application/json" },
    status,
  });

interface StoredLetter {
  readonly dated: string;
  readonly labelIds: readonly string[];
  readonly raw: string;
  readonly threadId: string;
}

export function fakeComposio(options: {
  readonly accounts: readonly {
    readonly id: string;
    readonly status: string;
    readonly userId: string;
  }[];
  readonly apiKey: string;
  readonly mailbox: string;
  /** Google's answer to deleting a letter, e.g. 403 for a grant without full mail. */
  readonly letterDeleteStatus?: number;
}) {
  const calls: ProxyCall[] = [];
  const accountQueries: URLSearchParams[] = [];
  const letters = new Map<string, StoredLetter>();
  const trashed = new Set<string>();
  const events = new Map<string, z.infer<typeof eventSchema>>();
  const files = new Map<string, { content: string; name?: string }>();
  const labels = new Map<string, string>([["Label_old", "Работа"]]);
  let counter = 0;
  const nextId = (prefix: string) => {
    counter += 1;
    return `${prefix}${String(counter)}`;
  };

  function google(call: ProxyCall) {
    const url = new URL(call.endpoint);
    const path = url.pathname;
    const route = `${call.method} ${path}`;
    const query = new Map(call.parameters.map((p) => [p.name, p.value]));
    if (route === "GET /gmail/v1/users/me/profile") {
      return { data: { emailAddress: options.mailbox }, status: 200 };
    }
    if (route === "GET /gmail/v1/users/me/labels") {
      return {
        data: { labels: [...labels].map(([id, name]) => ({ id, name })) },
        status: 200,
      };
    }
    if (route === "POST /gmail/v1/users/me/labels") {
      const id = nextId("Label_");
      labels.set(id, z.object({ name: z.string() }).parse(call.body).name);
      return { data: { id }, status: 200 };
    }
    if (route === "POST /gmail/v1/users/me/messages") {
      const body = insertSchema.parse(call.body);
      const id = nextId("m");
      const threadId = body.threadId ?? nextId("t");
      letters.set(id, {
        dated: query.get("internalDateSource") ?? "",
        labelIds: body.labelIds,
        raw: body.raw,
        threadId,
      });
      return { data: { id, threadId }, status: 200 };
    }
    const message =
      /^\/gmail\/v1\/users\/me\/messages\/([^/]+)(\/trash)?$/u.exec(path);
    if (message?.[1]) {
      const id = decodeURIComponent(message[1]);
      if (!letters.has(id)) return { data: null, status: 404 };
      if (message[2] && call.method === "POST") {
        trashed.add(id);
        return { data: { id }, status: 200 };
      }
      if (call.method === "DELETE") {
        const status = options.letterDeleteStatus ?? 204;
        if (status === 204) letters.delete(id);
        return {
          data:
            status === 204
              ? null
              : {
                  error: {
                    message: "Request had insufficient authentication scopes.",
                  },
                },
          status,
        };
      }
    }
    const label = /^\/gmail\/v1\/users\/me\/labels\/([^/]+)$/u.exec(path);
    if (label?.[1] && call.method === "DELETE") {
      labels.delete(decodeURIComponent(label[1]));
      return { data: null, status: 204 };
    }
    if (route === "POST /calendar/v3/calendars/primary/events") {
      const id = nextId("e");
      events.set(id, eventSchema.parse(call.body));
      return { data: { id }, status: 200 };
    }
    const event = /^\/calendar\/v3\/calendars\/primary\/events\/([^/]+)$/u.exec(
      path
    );
    if (event?.[1] && call.method === "DELETE") {
      return events.delete(decodeURIComponent(event[1]))
        ? { data: null, status: 204 }
        : {
            data: { error: { message: "Resource has been deleted" } },
            status: 410,
          };
    }
    if (route === "POST /upload/drive/v3/files") {
      const id = nextId("f");
      files.set(id, {
        content: Buffer.from(
          call.binary_body?.base64 ?? "",
          "base64"
        ).toString(),
      });
      return { data: { id }, status: 200 };
    }
    const file = /^\/drive\/v3\/files\/([^/]+)$/u.exec(path);
    if (file?.[1]) {
      const id = decodeURIComponent(file[1]);
      const stored = files.get(id);
      if (!stored) return { data: null, status: 404 };
      if (call.method === "PATCH") {
        stored.name = z.object({ name: z.string() }).parse(call.body).name;
        return { data: { id }, status: 200 };
      }
      if (call.method === "DELETE") {
        files.delete(id);
        return { data: null, status: 204 };
      }
    }
    return { data: { error: { message: `no route ${route}` } }, status: 400 };
  }

  async function fetchImpl(input: RequestInfo | URL, init?: RequestInit) {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    if (headers.get("x-api-key") !== options.apiKey) {
      return json(
        JSON.stringify({ error: { message: "Invalid API key" } }),
        401
      );
    }
    if (url.pathname === "/api/v3/connected_accounts") {
      accountQueries.push(url.searchParams);
      const users = (url.searchParams.get("user_ids") ?? "").split(",");
      return json(
        JSON.stringify({
          items: options.accounts
            .filter((account) => users.includes(account.userId))
            .map((account) => ({
              // Composio returns connection data; the driver must drop it.
              data: { access_token: "never-read" },
              id: account.id,
              status: account.status,
              toolkit: { slug: "googlesuper" },
              user_id: account.userId,
            })),
        })
      );
    }
    if (url.pathname === "/api/v3/tools/execute/proxy") {
      const call = proxyBodySchema.parse(
        JSON.parse(z.string().parse(init?.body))
      );
      calls.push(call);
      const { data, status } = google(call);
      return json(JSON.stringify({ data, headers: {}, status }));
    }
    return json(JSON.stringify({ error: { message: "not found" } }), 404);
  }

  return {
    accountQueries,
    calls,
    events,
    fetch: fetchImpl,
    files,
    labels,
    letters,
    trashed,
  };
}

/** A raw message's headers (encoded words decoded, folds joined) and body. */
export function readRawLetter(raw: string) {
  const text = Buffer.from(raw, "base64url").toString();
  const [head = "", body = ""] = text.split("\r\n\r\n");
  const headers = new Map<string, string>();
  for (const line of head.replaceAll(/\r\n\s+/gu, " ").split("\r\n")) {
    const separator = line.indexOf(": ");
    headers.set(
      line.slice(0, separator).toLowerCase(),
      line
        .slice(separator + 2)
        .replaceAll(/=\?UTF-8\?B\?([^?]+)\?=\s?/gu, (_match, encoded: string) =>
          Buffer.from(encoded, "base64").toString()
        )
    );
  }
  return {
    body: Buffer.from(body.replaceAll("\r\n", ""), "base64").toString(),
    headers,
    text,
  };
}
