import { lookup as dnsLookup } from "node:dns";
import type { LookupFunction } from "node:net";
import { Agent, WebSocket as UndiciWebSocket } from "undici";
import { env } from "@shared/environment";
import { within } from "@agent/lib/browser-use/deadline";
import { listCloudRuPrivateAddresses } from "./cloudru";

/**
 * Calls from a Cloud.ru VM to the project's other VMs (the code sandbox host,
 * the browser pool's hosts, the browser VMs' workers). Bro knows them as
 * `https://<public IP with dashes>.sslip.io`, the name their Caddy holds a
 * certificate for, but one VM of the project cannot reach another one's
 * public address: the connection hangs (02.10.2026). With
 * CLOUDRU_PRIVATE_ROUTING=on such a name is dialed at the VM's address in
 * the project's subnet, looked up in the Compute API, while TLS still names
 * and checks the sslip.io host. Every other name resolves as it always does.
 * Off (Vercel), nothing changes.
 */

const sslipName = /^(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})\.sslip\.io$/iu;
/**
 * A known address is trusted this long, then listed again before use. A VM
 * keeps its addresses for life, but a deleted VM's floating IP may go to the
 * next VM at once: an older map would dial the gone VM's private address.
 */
const freshMs = 30_000;
/**
 * An address a listing lacked is dialed publicly this long before it is
 * looked up again, so a name outside the project costs no Compute API read
 * per call. Counted per address: a VM created after the last listing is not
 * held back by another address's miss, and its first call lists again. Short,
 * since a VM whose floating IP the listing lagged hangs on its public address
 * until the window ends.
 */
const missMs = 10_000;
/** After a failed listing, none is tried again this long. */
const failureMs = 30_000;
/** A connection waits no longer than this for a listing in flight. */
const listingWaitMs = 5_000;

let known:
  | { readonly at: number; readonly addresses: ReadonlyMap<string, string> }
  | undefined;
const misses = new Map<string, number>();
let failedAt: number | undefined;
let refreshing: Promise<ReadonlyMap<string, string>> | undefined;
let agent: Agent | undefined;

function noteMiss(publicAddress: string, at: number) {
  for (const [address, missedAt] of misses) {
    if (at - missedAt >= missMs) misses.delete(address);
  }
  misses.set(publicAddress, at);
}

async function listOnce() {
  try {
    const addresses = await listCloudRuPrivateAddresses();
    known = { addresses, at: Date.now() };
    failedAt = undefined;
    return addresses;
  } catch (error) {
    // The old map, if any, serves on; no listing for `failureMs`.
    failedAt = Date.now();
    console.warn("[private-route] could not list the project's VMs", {
      error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    });
    throw error;
  } finally {
    refreshing = undefined;
  }
}

/** The listing in flight, started if none is: one Compute API read at a time. */
function listing() {
  refreshing ??= listOnce();
  return refreshing;
}

/**
 * The private address of the project's VM at this public one, or undefined
 * when the project lists none (or the Compute API cannot say in time): then
 * the public address is dialed, as without routing.
 */
async function privateAddressOf(publicAddress: string) {
  const now = Date.now();
  const found = known?.addresses.get(publicAddress);
  if (found !== undefined && known !== undefined && now - known.at < freshMs) {
    return found;
  }
  const missedAt = misses.get(publicAddress);
  if (
    found === undefined &&
    missedAt !== undefined &&
    now - missedAt < missMs
  ) {
    return undefined;
  }
  if (failedAt !== undefined && now - failedAt < failureMs) return found;
  try {
    const listed = await within(listing(), listingWaitMs);
    // Still listing: this connection goes on with what is known.
    if (listed.timedOut) return found;
    const address = listed.value.get(publicAddress);
    if (address === undefined) noteMiss(publicAddress, Date.now());
    else misses.delete(publicAddress);
    return address;
  } catch {
    return found;
  }
}

/** The public address an sslip.io name stands for, or undefined for any other name. */
function sslipAddress(hostname: string) {
  const match = sslipName.exec(hostname);
  return match === null ? undefined : match.slice(1, 5).join(".");
}

const lookup: LookupFunction = (hostname, options, callback) => {
  // An sslip.io name resolves to the address written in it.
  const publicAddress = sslipAddress(hostname);
  if (publicAddress === undefined) {
    dnsLookup(hostname, options, callback);
    return;
  }
  void (async () => {
    // Never rejects: a failed listing falls back to the public address.
    const address = (await privateAddressOf(publicAddress)) ?? publicAddress;
    if (options.all === true) {
      callback(null, [{ address, family: 4 }]);
    } else {
      callback(null, address, 4);
    }
  })();
};

/**
 * The undici dispatcher that dials the project's VMs privately, or
 * undefined when CLOUDRU_PRIVATE_ROUTING is off.
 */
export function privateRouteDispatcher() {
  if (env.CLOUDRU_PRIVATE_ROUTING !== "on") return undefined;
  agent ??= new Agent({ connect: { lookup } });
  return agent;
}

/**
 * Looks up the private address behind `url` ahead of a request to it, so a
 * timeout started after this is the VM's to answer in, not spent waiting on
 * the Compute API (the lookup then finds it known). Resolves either way:
 * without an address the request dials the public one, as without routing.
 */
export async function resolvePrivateRoute(url: string) {
  if (env.CLOUDRU_PRIVATE_ROUTING !== "on") return;
  const publicAddress = sslipAddress(new URL(url).hostname);
  if (publicAddress !== undefined) await privateAddressOf(publicAddress);
}

/**
 * `init` for a `fetch` to one of the project's VMs: with the private
 * dispatcher when routing is on, as it is otherwise. Node's `fetch` takes
 * undici's `dispatcher` next to the standard fields.
 */
export function withPrivateRoute<T extends RequestInit>(init: T): T {
  const dispatcher = privateRouteDispatcher();
  return dispatcher === undefined ? init : Object.assign(init, { dispatcher });
}

/**
 * A WebSocket to one of the project's VMs (a browser's debugger). undici's
 * own class, the implementation behind Node's global one, because only its
 * constructor takes a dispatcher; while routing is off it has none and goes
 * through Node's global dispatcher like any other socket.
 */
export function openPrivateRouteWebSocket(url: string) {
  const dispatcher = privateRouteDispatcher();
  return dispatcher === undefined
    ? new UndiciWebSocket(url)
    : new UndiciWebSocket(url, { dispatcher });
}
