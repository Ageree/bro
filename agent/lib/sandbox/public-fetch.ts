import { lookup, type LookupAddress } from "node:dns";
import { Agent, request } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { pipeline, type Readable, type Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { IncomingMessage } from "node:http";

/**
 * The requests the sandbox tool router makes for a sandbox
 * (`agent/lib/sandbox/router.ts`): a host name is resolved here, every
 * address it resolves to must be public, and the connection goes to those
 * very addresses. A name that points inside the network — a private,
 * loopback, link-local, CGNAT or metadata address — is refused before any
 * byte leaves, and a second lookup cannot swap the address after the check.
 */

/** Addresses no public site lives at (RFC 6890 and kin). */
const nonPublicRanges = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  nonPublicRanges.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 127],
  // IPv4 inside IPv6 (NAT64, 6to4, Teredo) could carry any of the ranges
  // above. A mapped `::ffff:a.b.c.d` is checked against them by BlockList
  // itself: a rule for all of `::ffff:0:0/96` would match every IPv4 too.
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  nonPublicRanges.addSubnet(network, prefix, "ipv6");
}

export function isPublicAddress(address: string) {
  const family = isIP(address);
  if (family === 0) return false;
  return !nonPublicRanges.check(address, family === 4 ? "ipv4" : "ipv6");
}

class BlockedAddressError extends Error {
  constructor(hostname: string) {
    super(`${hostname} does not resolve to a public address.`);
    // `downloadWithin` reports a hop refused by name as a blocked host.
    this.name = "BlockedHostError";
  }
}

/** DNS as the connection sees it: only an all-public answer goes through. */
const publicLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, "");
      return;
    }
    const first = addresses[0];
    if (
      first === undefined ||
      !addresses.every((entry: LookupAddress) => isPublicAddress(entry.address))
    ) {
      callback(new BlockedAddressError(hostname), "");
      return;
    }
    if (options.all === true) callback(null, addresses);
    else callback(null, first.address, first.family);
  });
};

const publicAgent = new Agent({ lookup: publicLookup });

const nullBodyStatuses: ReadonlySet<number> = new Set([204, 205, 304]);

const decoders = {
  br: createBrotliDecompress,
  deflate: createInflate,
  gzip: createGunzip,
  "x-gzip": createGunzip,
} satisfies Record<string, () => Transform>;

function isKnownCoding(coding: string): coding is keyof typeof decoders {
  return Object.hasOwn(decoders, coding);
}

/**
 * Codings a body may stack. A site could list thousands in one header, each
 * a decoder of its own: minutes of work and hundreds of megabytes for one
 * small answer (curl caps the chain at five too, CVE-2022-32206).
 */
const maximumCodings = 5;

/**
 * The decoders for a `Content-Encoding`, in the order they undo it: codings
 * are listed as applied (`gzip, br` is gzip, then Brotli). A body in a
 * coding not undone here would reach the page reader still encoded, so the
 * request fails instead, as a network error (the error is returned).
 */
function decodersFor(header: string | undefined) {
  const codings = (header ?? "")
    .split(",")
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding.length > 0 && coding !== "identity");
  if (codings.length > maximumCodings) {
    return new TypeError(
      `The site stacked ${String(codings.length)} content codings.`
    );
  }
  const chain: Transform[] = [];
  for (const coding of codings.toReversed()) {
    if (!isKnownCoding(coding)) {
      return new TypeError(
        `The site sent an unknown content coding: ${coding}.`
      );
    }
    chain.push(decoders[coding]());
  }
  return chain;
}

/** The body as sent, or decoded; an aborted response fails its decoders too. */
function decoded(response: IncomingMessage, chain: readonly Transform[]) {
  const last = chain.at(-1);
  if (last === undefined) return response;
  pipeline([response, ...chain], () => undefined);
  return last;
}

/** A body as fetch hands it over, read only as fast as its reader asks. */
function webBody(body: Readable) {
  // Once the reader cancelled, what the socket still says goes nowhere.
  let settled = false;
  return new ReadableStream<Uint8Array>({
    // A reader that has enough (the size cap) closes the connection.
    cancel: () => {
      settled = true;
      body.destroy();
    },
    pull: () => {
      body.resume();
    },
    start: (controller) => {
      body.pause();
      body.on("data", (chunk: Buffer) => {
        if (settled) return;
        controller.enqueue(chunk);
        if ((controller.desiredSize ?? 0) <= 0) body.pause();
      });
      body.once("end", () => {
        if (settled) return;
        settled = true;
        controller.close();
      });
      body.once("error", (error) => {
        if (settled) return;
        settled = true;
        controller.error(error);
      });
    },
  });
}

function responseHeaders(response: IncomingMessage, decodedBody: boolean) {
  const headers = new Headers();
  const raw = response.rawHeaders;
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const name = raw[index] ?? "";
    // A decoded body's length is not the one the server declared.
    if (decodedBody && /^content-(?:encoding|length)$/iu.test(name)) {
      continue;
    }
    try {
      headers.append(name, raw[index + 1] ?? "");
    } catch {
      // A header the Fetch API cannot hold says nothing the router reads.
    }
  }
  return headers;
}

/**
 * One GET to a public HTTPS host, answered as a fetch `Response`. Redirects
 * are never followed here: the caller checks each hop (`downloadWithin` with
 * `allowUrl`) and asks again. An IP literal skips the lookup, so it is
 * checked here itself (the router refuses every one by name anyway).
 */
export async function fetchPublic(url: URL, init: RequestInit = {}) {
  if (url.protocol !== "https:") {
    throw new TypeError("Only https:// URLs can be fetched.");
  }
  const literal = url.hostname.replace(/^\[(?<address>.*)\]$/u, "$<address>");
  if (isIP(literal) !== 0 && !isPublicAddress(literal)) {
    throw new BlockedAddressError(url.hostname);
  }
  const { signal } = init;
  signal?.throwIfAborted();
  return await new Promise<Response>((resolve, reject) => {
    const headers = new Headers(init.headers);
    if (!headers.has("accept-encoding")) {
      headers.set("accept-encoding", "gzip, deflate, br");
    }
    let answer: IncomingMessage | undefined;
    const outgoing = request(
      url,
      {
        agent: publicAgent,
        headers: Object.fromEntries(headers),
        method: "GET",
      },
      (response) => {
        answer = response;
        const status = response.statusCode ?? 502;
        // A status fetch cannot hold (a site may answer 999) would throw
        // here, inside the socket's event, and take the whole process down.
        if (status < 200 || status > 599) {
          const error = new Error(
            `The site answered with status ${String(status)}.`
          );
          response.destroy(error);
          reject(error);
          return;
        }
        const empty = nullBodyStatuses.has(status);
        const chain = empty
          ? []
          : decodersFor(response.headers["content-encoding"]);
        if (chain instanceof Error) {
          response.destroy();
          reject(chain);
          return;
        }
        const body = decoded(response, chain);
        resolve(
          new Response(empty ? null : webBody(body), {
            headers: responseHeaders(response, body !== response),
            status,
          })
        );
      }
    );
    const abort = () => {
      const reason: unknown = signal?.reason;
      const error = reason instanceof Error ? reason : new Error("Aborted.");
      outgoing.destroy(error);
      answer?.destroy(error);
      reject(error);
    };
    signal?.addEventListener("abort", abort, { once: true });
    outgoing.on("close", () => {
      signal?.removeEventListener("abort", abort);
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}
