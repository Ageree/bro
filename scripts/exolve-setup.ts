/**
 * One-shot Exolve helper. Needs EXOLVE_API_KEY.
 * Creates a callback resource if none exist. Optionally verifies EXOLVE_NUMBER.
 * Does not place a live call.
 */
const API = "https://api.exolve.ru";

function key(): string {
  const k = (process.env.EXOLVE_API_KEY ?? "").trim();
  if (!k) throw new Error("EXOLVE_API_KEY missing");
  return k;
}

async function exolve<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key()}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`exolve ${path} ${res.status}: ${text.slice(0, 400)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

type CallbackRow = {
  callback_resource_id?: string;
  callback_name?: string;
};

const callbacks = await exolve<{ callbacks?: CallbackRow[] }>(
  "/callback/v1/GetList",
  {},
);
let resources = callbacks.callbacks ?? [];
if (resources.length === 0) {
  const created = await exolve<{ callback_resource_id?: string }>(
    "/callback/v1/Create",
    { callback_name: "bro-ru", description: "Inkbox hairpin" },
  );
  console.log("created callback resource", created.callback_resource_id);
  resources = [
    {
      callback_resource_id: created.callback_resource_id,
      callback_name: "bro-ru",
    },
  ];
}
console.log("callback resources");
for (const row of resources) {
  console.log(`  ${row.callback_resource_id ?? "?"} ${row.callback_name ?? ""}`);
}

const rawNumber = (process.env.EXOLVE_NUMBER ?? "").replace(/[^\d]/g, "");
if (rawNumber) {
  const info = await exolve<{ number?: { number_name?: string } }>(
    "/number/customer/v1/GetInfo",
    { number_code: Number(rawNumber) },
  );
  console.log("number ok", info.number?.number_name ?? rawNumber);
}

const firstResource = resources[0]?.callback_resource_id;
console.log("set on Convex + Vercel (do not commit):");
console.log(`EXOLVE_NUMBER=+${rawNumber || "7XXXXXXXXXX"}`);
console.log(`EXOLVE_CALLBACK_RESOURCE_ID=${firstResource ?? "?"}`);
console.log("EXOLVE_API_KEY=<same key>");
