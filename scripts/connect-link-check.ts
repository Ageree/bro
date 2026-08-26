import {
  isConnectDest,
  stripConnectUrls,
  wrapConnectUrl,
} from "../agent/lib/connect-link.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const good = "https://connect.composio.dev/link/lk_abc";
assert(isConnectDest(good), "allow composio link");
assert(!isConnectDest("https://evil.example/link/lk_abc"), "reject other host");
assert(!isConnectDest("https://connect.composio.dev/other"), "reject other path");

process.env.BRO_PUBLIC_URL = "https://bro-agent.vercel.app";
assert(
  wrapConnectUrl(good) ===
    "https://bro-agent.vercel.app/l?to=" + encodeURIComponent(good),
  "wrap",
);

assert(
  stripConnectUrls("Открой [Gmail](https://connect.composio.dev/link/lk_x) сейчас") ===
    "Открой  сейчас",
  "strip markdown",
);
assert(stripConnectUrls(`Подключи: ${good}`) === "Подключи:", "strip raw url");

console.log("connect-link-check ok");
