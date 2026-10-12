import { ProxyAgent, fetch as undiciFetch } from "undici";
import { z } from "zod";
import { openCdpConnection } from "@agent/lib/browser-use/cdp";
import { browserVmProfileId } from "@agent/lib/browser-vm/ids";
import {
  browserVmProxy,
  browserVmProxySession,
} from "@agent/lib/browser-vm/proxy";
import {
  createBrowserVmBrowser,
  stopBrowserVmBrowser,
} from "@agent/lib/browser-vm/runs";
import { isYandexHost } from "@agent/lib/yandex/operations";
import { accountReadyOperation } from "@agent/lib/yandex/ready";
import { statusOperation } from "@agent/lib/yandex/status";
import { runYandexOperation } from "@agent/lib/yandex/transport";

/**
 * An operator's measurement of «method 4» (docs/yandex-api/speed.md): read
 * operations asked from the server with the cookies of the person's pool
 * browser, to see whether Yandex accepts them, what they save, and whether
 * the person stays signed in. READS ONLY, one workspace (the owner's, who
 * allowed it on 12.10).
 *
 *   host.py ops NAME yandex-session-probe.sh s3get:<spec key> s3put:<result key>
 *
 * Spec: `{workspace}`, which must equal YANDEX_PROBE_WORKSPACE in the ops
 * environment (the owner's). The cookies live in this process's memory only: they
 * are not written to a file, a log or the result. The result holds cookie
 * NAMES and their count, and for each request a status, a time, the host a
 * redirect points to and whether the answer looks signed in: no body, no
 * header value, no cookie value.
 */

const specSchema = z.strictObject({ workspace: z.string().min(1) });

const cookiesSchema = z.object({
  cookies: z.array(
    z.object({
      domain: z.string(),
      name: z.string(),
      path: z.string(),
      secure: z.boolean().optional(),
      value: z.string(),
    })
  ),
});

type Cookie = z.infer<typeof cookiesSchema>["cookies"][number];

const userAgent =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const gqlQuery =
  "query BroSearch($text: String!, $docs: Int!){search(text:$text,groups:5,docs:$docs,page:0,filterByDeviceType:web,filterByTypes:[event],groupBy:groupCode){groups{code documentsTotal}}}";

/** Each probe is one read; `signedIn` looks at the body without keeping it. */
const probes = [
  {
    id: "afisha.search",
    init: {
      body: JSON.stringify({
        operationName: "BroSearch",
        query: gqlQuery,
        variables: { docs: 3, text: "джаз" },
      }),
      headers: {
        "content-type": "application/json",
        "x-force-cors-preflight": "1",
      },
      method: "POST",
    },
    signedIn: (body: string) => body.includes('"search"'),
    url: "https://afisha.yandex.ru/api/graphql?city=moscow&version=604.1.0&query_name=BroSearch",
  },
  {
    id: "market.wishlist",
    init: { method: "GET" },
    signedIn: (body: string) => /"sk":"u[0-9a-f]{20,}"/u.test(body),
    url: "https://market.yandex.ru/my/wishlist",
  },
  {
    id: "eda.search",
    init: {
      body: JSON.stringify({
        filters: [],
        location: { latitude: 55.7558, longitude: 37.6173 },
        text: "пицца",
      }),
      headers: {
        "content-type": "application/json;charset=UTF-8",
        "x-app-version": "18.50.1",
        "x-platform": "desktop_web",
        "x-ya-coordinates": "latitude=55.7558,longitude=37.6173",
      },
      method: "POST",
    },
    signedIn: (body: string) => body.includes('"header"'),
    url: "https://eda.yandex.ru/eats/v1/full-text-search/v1/search",
  },
];

function cookieHeader(cookies: readonly Cookie[], url: string) {
  const host = new URL(url).hostname;
  return cookies
    .filter((cookie) => {
      const domain = cookie.domain.replace(/^\./u, "");
      return host === domain || host.endsWith(`.${domain}`);
    })
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

async function readCookies(cdpUrl: string) {
  const connection = await openCdpConnection(cdpUrl);
  try {
    const reply = cookiesSchema.parse(
      await connection.call("Network.getAllCookies", {})
    );
    return reply.cookies.filter((cookie) =>
      isYandexHost(cookie.domain.replace(/^\./u, ""))
    );
  } finally {
    connection.close();
  }
}

async function ask(
  probe: (typeof probes)[number],
  cookies: readonly Cookie[],
  dispatcher: ProxyAgent | undefined
) {
  const began = Date.now();
  try {
    const response = await undiciFetch(probe.url, {
      ...probe.init,
      dispatcher,
      headers: {
        ...probe.init.headers,
        cookie: cookieHeader(cookies, probe.url),
        "user-agent": userAgent,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    const location = response.headers.get("location");
    const body = response.status === 200 ? await response.text() : "";
    return {
      id: probe.id,
      ms: Date.now() - began,
      redirectsTo: location
        ? (URL.parse(location, probe.url)?.hostname ?? "?")
        : null,
      setCookies: response.headers.getSetCookie().length,
      signedIn: probe.signedIn(body),
      status: response.status,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.name : "unknown",
      id: probe.id,
      ms: Date.now() - began,
    };
  }
}

const accepted = (answer: Awaited<ReturnType<typeof ask>>) =>
  "status" in answer &&
  answer.status === 200 &&
  answer.signedIn &&
  answer.redirectsTo === null;

async function main() {
  const [specUrl, resultUrl] = process.argv.slice(2);
  if (!specUrl || !resultUrl) {
    throw new Error(
      "Usage: yandex-session-probe.sh SPEC_GET_URL RESULT_PUT_URL"
    );
  }
  const { workspace } = specSchema.parse(await (await fetch(specUrl)).json());
  // Only the owner's workspace, named by the operator's environment: the
  // spec alone cannot point this at somebody else's cookies.
  // oxlint-disable-next-line eslint/no-restricted-properties -- a one-shot CLI on the VM with the ops environment, not the app
  const environment = process.env;
  if (environment.YANDEX_PROBE_WORKSPACE !== workspace) {
    throw new Error("The workspace is not the one allowed for the probe.");
  }
  const tab = await createBrowserVmBrowser({
    profileId: browserVmProfileId(workspace, 0),
    wake: true,
  });
  let cookies: Cookie[];
  try {
    cookies = await readCookies(tab.cdpUrl);
  } finally {
    await stopBrowserVmBrowser(tab.id);
  }
  const proxy = browserVmProxy(browserVmProxySession(workspace));
  const through = new ProxyAgent(
    `http://${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@${proxy.host}:${String(proxy.port)}`
  );
  // One request at a time, the proxy's exit first (the address the person's
  // browser has): the server's own address only if every proxied read was
  // accepted, and the first refusal, captcha or sign-in redirect stops all.
  const run = async (dispatcher: ProxyAgent | undefined) => {
    const answers: Awaited<ReturnType<typeof ask>>[] = [];
    // Twice each: the first may be slower, the second is the steady one.
    for (const probe of probes.flatMap((one) => [one, one])) {
      // oxlint-disable-next-line no-await-in-loop -- stop at the first refusal
      const answer = await ask(probe, cookies, dispatcher);
      answers.push(answer);
      if (!accepted(answer)) break;
    }
    return answers;
  };
  const proxied = await run(through);
  const direct =
    proxied.length === probes.length * 2 && proxied.every(accepted)
      ? await run(undefined)
      : [];
  const result = {
    cookieCount: cookies.length,
    cookieNames: [...new Set(cookies.map((cookie) => cookie.name))].toSorted(),
    direct,
    proxied,
    // The person must still be signed in, in the browser.
    stillSignedIn: {
      accountReady: (
        await runYandexOperation(workspace, accountReadyOperation, {})
      ).kind,
      status: (await runYandexOperation(workspace, statusOperation, {})).kind,
    },
  };
  const put = await fetch(resultUrl, {
    body: JSON.stringify(result),
    method: "PUT",
  });
  console.log(JSON.stringify({ stored: put.ok, status: put.status }));
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.name : "failed");
  process.exitCode = 1;
} finally {
  process.exit();
}
