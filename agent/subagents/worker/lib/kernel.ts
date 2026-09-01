/**
 * Kernel cloud-browser client for the worker subagent.
 *
 * One persistent Kernel profile per tenant carries that person's logins and
 * cookies. Egress goes through a residential proxy in the tenant's country
 * because most Russian merchants refuse foreign IPs.
 */
import Kernel from "@onkernel/sdk";
import { createHash } from "node:crypto";

const PROFILE_PREFIX = "bro";

let cachedClient: Kernel | undefined;
const profileIds = new Map<string, string>();
let proxyIdPromise: Promise<string | undefined> | undefined;

export function kernelEnabled(): boolean {
  return Boolean(process.env.KERNEL_API_KEY?.trim());
}

export function kernel(): Kernel {
  const apiKey = process.env.KERNEL_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "KERNEL_API_KEY missing — браузер с логинами и оплатой недоступен на этом хосте",
    );
  }
  cachedClient ??= new Kernel({ apiKey });
  return cachedClient;
}

/** Stable, non-reversible profile name. The phone number never reaches Kernel. */
export function profileNameForTenant(phoneE164: string): string {
  const digest = createHash("sha256")
    .update(`kernel-profile\u0000${phoneE164}`)
    .digest("hex")
    .slice(0, 40);
  return `${PROFILE_PREFIX}-${digest}`;
}

/** ISO 3166-1 alpha-2, or undefined when proxying is switched off. */
export function proxyCountry(
  raw: string | undefined = process.env.BRO_KERNEL_PROXY_COUNTRY ??
    process.env.BRO_BROWSER_PROXY,
): string | undefined {
  const value = (raw ?? "ru").trim().toLowerCase();
  if (!value || value === "none") return undefined;
  return /^[a-z]{2}$/.test(value) ? value.toUpperCase() : undefined;
}

export function proxyNameForCountry(country: string): string {
  return `${PROFILE_PREFIX}-residential-${country.toLowerCase()}`;
}

const REGIONS = ["us-east", "eu-west", "ap-southeast"] as const;

/** Kernel defaults to us-east; eu-west is the closest hop to Russian sites. */
export function kernelRegion(
  raw: string | undefined = process.env.BRO_KERNEL_REGION,
): (typeof REGIONS)[number] | undefined {
  const value = raw?.trim().toLowerCase();
  return REGIONS.find((region) => region === value);
}

export async function ensureTenantProfile(
  phoneE164: string,
  signal?: AbortSignal,
): Promise<string> {
  const name = profileNameForTenant(phoneE164);
  const cached = profileIds.get(name);
  if (cached) return cached;

  const client = kernel();
  const profile = await client.profiles
    .retrieve(name, { signal })
    .catch(async (error: unknown) => {
      if (!isStatus(error, 404)) throw error;
      return client.profiles.create({ name }, { signal }).catch((cause: unknown) => {
        if (!isStatus(cause, 409)) throw cause;
        return client.profiles.retrieve(name, { signal });
      });
    });
  profileIds.set(name, profile.id);
  return profile.id;
}

/**
 * Shared residential proxy for the configured country. `BRO_KERNEL_PROXY_ID`
 * overrides it with a bring-your-own proxy, which is the escape hatch when
 * Kernel has no pool in that country.
 */
export async function ensureProxyId(signal?: AbortSignal): Promise<string | undefined> {
  const explicit = process.env.BRO_KERNEL_PROXY_ID?.trim();
  if (explicit) return explicit;

  const country = proxyCountry();
  if (!country) return undefined;

  proxyIdPromise ??= resolveProxyId(country, signal).catch((error: unknown) => {
    proxyIdPromise = undefined;
    throw error;
  });
  return proxyIdPromise;
}

async function resolveProxyId(country: string, signal?: AbortSignal) {
  const client = kernel();
  const name = proxyNameForCountry(country);
  for await (const proxy of client.proxies.list({ name }, { signal })) {
    if (proxy.name === name) return proxy.id;
  }
  const created = await client.proxies.create(
    { type: "residential", name, config: { country } },
    { signal },
  );
  return created.id;
}

export function isStatus(cause: unknown, status: number): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "status" in cause &&
    (cause as { status?: unknown }).status === status
  );
}
