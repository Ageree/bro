import { env } from "@shared/environment";

/**
 * The deployment's own proxy, when it has one. Browser Use takes it per run and
 * neither stores it nor hands it to a follow-up, so every run this agent starts
 * asks for it again; without a host and a port the hosted pool is used, picked
 * by country.
 */
export function customProxy() {
  const host = env.BROWSER_USE_PROXY_HOST;
  const port = env.BROWSER_USE_PROXY_PORT;
  if (host === undefined || port === undefined) return undefined;
  return {
    host,
    password: env.BROWSER_USE_PROXY_PASSWORD,
    port,
    username: env.BROWSER_USE_PROXY_USERNAME,
  };
}

/**
 * Where a background retry after an anti-bot wall exits to the internet. The
 * site has already judged the address the last attempt came from, so each
 * retry asks for another one:
 *
 * - a proxy whose provider rotates by username gets a fresh session token;
 * - a fixed custom proxy alternates with the hosted residential pool, which
 *   hands every new browser its own address in the same country;
 * - the hosted pool alone already gives a new browser a new address.
 *
 * Attempt 1 is the run the person started; retries are 2 and up.
 */
export function retryProxySettings(attempt: number, sessionToken: string) {
  const proxyCountryCode = env.BROWSER_USE_PROXY_COUNTRY;
  const custom = customProxy();
  if (custom === undefined) return { customProxy: undefined, proxyCountryCode };
  const rotating = env.BROWSER_USE_PROXY_ROTATING_USERNAME;
  if (rotating !== undefined) {
    return {
      customProxy: {
        ...custom,
        username: rotating.replaceAll("{session}", sessionToken),
      },
      proxyCountryCode,
    };
  }
  return {
    customProxy: attempt % 2 === 0 ? undefined : custom,
    proxyCountryCode,
  };
}
