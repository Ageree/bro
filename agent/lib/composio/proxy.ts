import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import {
  ComposioError,
  composioRequest,
  isMissingConnectedAccount,
} from "@shared/composio/api";

/**
 * What Composio's proxy hands back: the upstream API's own status, headers
 * and body. A JSON body arrives parsed, any other text as a string, and a
 * file as `binary_data`, a short-lived download URL with its size.
 */
const proxyResponseSchema = z.object({
  binary_data: z
    .object({
      content_type: z.string(),
      size: z.number(),
      url: z.url(),
    })
    .nullish(),
  data: z.unknown(),
  headers: z.record(z.string(), z.string()).nullish(),
  status: z.number(),
});

type ProxyResponse = z.output<typeof proxyResponseSchema>;

type ProxyMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";

/**
 * How long a refused request waits before it is asked once more. From the
 * VM's addresses Composio now and then answers a bare 403 that the same
 * request, three seconds later, does not get.
 */
const refusedRetryMs = 3_000;

/**
 * Whether Composio itself refused the request before making it: a 403 of its
 * own that names no gone account. The proxy answers HTTP 200 for whatever
 * the provider said, whatever the status (the app's own 403 and 429 arrive in
 * `status`, not here), so an error raised here means the provider's API was
 * never called, and asking again cannot do a write twice.
 */
function refusedBeforeExecuting(cause: unknown) {
  return (
    cause instanceof ComposioError &&
    cause.status === 403 &&
    !isMissingConnectedAccount(cause)
  );
}

/**
 * One request to a provider's API made as the person: Composio signs it
 * with the grant of `connectedAccountId`, which never reaches Bro. `url` is
 * absolute and stays on the toolkit's own domain (Composio refuses any
 * other), query string included, so a repeated parameter keeps every value.
 */
export async function composioProxy(
  connectedAccountId: string,
  request: {
    readonly body?: object;
    /** Extra headers, such as an API version; Composio adds the credential. */
    readonly headers?: Readonly<Record<string, string>>;
    readonly method: ProxyMethod;
    readonly signal: AbortSignal;
    readonly url: string;
  }
) {
  const send = () =>
    composioRequest(proxyResponseSchema, "/tools/execute/proxy", {
      body: {
        body: request.body ?? null,
        connected_account_id: connectedAccountId,
        endpoint: request.url,
        method: request.method,
        parameters: Object.entries(request.headers ?? {}).map(
          ([name, value]) => ({ name, type: "header", value })
        ),
      },
      method: "POST",
      signal: request.signal,
    });
  try {
    return await send();
  } catch (error) {
    if (!refusedBeforeExecuting(error)) throw error;
    await setTimeout(refusedRetryMs, undefined, { signal: request.signal });
    return send();
  }
}

/**
 * A proxied body as bytes within `maxBytes`: a file is downloaded from the
 * URL Composio stored it under, checked against its declared size first, and
 * text or JSON the proxy parsed is encoded back. Text can be restored this
 * way, a binary file only from its download.
 */
export async function proxyBodyBytes(
  response: ProxyResponse,
  maxBytes: number,
  signal: AbortSignal
): Promise<
  | {
      readonly kind: "bytes";
      readonly bytes: Uint8Array;
      readonly file: boolean;
    }
  | { readonly kind: "oversize" }
> {
  const binary = response.binary_data;
  if (binary) {
    if (binary.size > maxBytes) return { kind: "oversize" };
    const download = await fetch(binary.url, { signal });
    if (!download.ok) {
      throw new Error(
        `The proxied file could not be downloaded (${String(download.status)}).`
      );
    }
    const bytes = new Uint8Array(await download.arrayBuffer());
    return bytes.byteLength > maxBytes
      ? { kind: "oversize" }
      : { bytes, file: true, kind: "bytes" };
  }
  const text = z.string().safeParse(response.data);
  const bytes = new TextEncoder().encode(
    text.success ? text.data : JSON.stringify(response.data ?? null)
  );
  return bytes.byteLength > maxBytes
    ? { kind: "oversize" }
    : { bytes, file: false, kind: "bytes" };
}
