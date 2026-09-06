import {
  SANDBOX_NETWORK_RULE,
  sandboxNetworkViolation,
} from "../agent/lib/sandbox-policy.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

// Python HTTP client hitting a real site
assert(
  sandboxNetworkViolation(
    'import requests\nrequests.get("https://www.ozon.ru/search?text=book")',
  ) === SANDBOX_NETWORK_RULE,
  "requests.get on ozon.ru is a violation",
);

// shell curl
assert(
  sandboxNetworkViolation("curl -s https://www.ozon.ru/") === SANDBOX_NETWORK_RULE,
  "curl is a violation",
);

// shell wget
assert(
  sandboxNetworkViolation("wget ozon.ru") === SANDBOX_NETWORK_RULE,
  "wget is a violation",
);

// JS fetch
assert(
  sandboxNetworkViolation('fetch("https://wildberries.ru")') === SANDBOX_NETWORK_RULE,
  "fetch on wildberries.ru is a violation",
);

// python httpx import
assert(
  sandboxNetworkViolation("import httpx") === SANDBOX_NETWORK_RULE,
  "import httpx is a violation",
);

// benign: local JSON post-processing
assert(
  sandboxNetworkViolation('import json\nprint(json.loads(data)["items"][:5])') === null,
  "json post-processing is fine",
);

// benign: local shell inspection
assert(
  sandboxNetworkViolation("ls -la /tmp && head -c 200 out.json") === null,
  "local shell inspection is fine",
);

// benign: real Composio API host stays allowed
assert(
  sandboxNetworkViolation("https://backend.composio.dev/api/v3/tools") === null,
  "composio.dev host is allowed",
);

console.log("sandbox-policy-check ok");
