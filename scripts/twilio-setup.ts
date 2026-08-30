/**
 * Buy a US local DID, point Voice at Convex /twilio-voice, enable RU/+7.
 * Needs TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN.
 * Optional: TWILIO_VOICE_URL, BRO_INTERNAL_SECRET (appended as ?secret=).
 * Does not place a live call.
 */
const SID = (process.env.TWILIO_ACCOUNT_SID ?? "").trim();
const TOKEN = (process.env.TWILIO_AUTH_TOKEN ?? "").trim();
const API_KEY = (process.env.TWILIO_API_KEY ?? "").trim();
const API_SECRET = (process.env.TWILIO_API_SECRET ?? "").trim();
if (!SID) throw new Error("TWILIO_ACCOUNT_SID missing");
const user = API_KEY || SID;
const pass = API_SECRET || TOKEN;
if (!pass) throw new Error("TWILIO_AUTH_TOKEN or TWILIO_API_KEY+TWILIO_API_SECRET missing");

const AUTH = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
const API = `https://api.twilio.com/2010-04-01/Accounts/${SID}`;

async function twilio<T>(
  url: string,
  init?: { method?: string; body?: URLSearchParams },
): Promise<T> {
  const res = await fetch(url, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: AUTH,
      Accept: "application/json",
      ...(init?.body
        ? { "Content-Type": "application/x-www-form-urlencoded" }
        : {}),
    },
    body: init?.body,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`twilio ${url} ${res.status}: ${text.slice(0, 400)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

function voiceUrl(): string {
  const base = (
    process.env.TWILIO_VOICE_URL ??
    "https://frugal-dragon-943.convex.site/twilio-voice"
  ).trim();
  const secret = (process.env.BRO_INTERNAL_SECRET ?? "").trim();
  if (!secret) return base;
  const u = new URL(base);
  u.searchParams.set("secret", secret);
  return u.toString();
}

const owned = await twilio<{ incoming_phone_numbers?: { phone_number?: string; sid?: string }[] }>(
  `${API}/IncomingPhoneNumbers.json?PageSize=20`,
);
let number = (process.env.TWILIO_NUMBER ?? "").trim();
let numberSid = "";
for (const row of owned.incoming_phone_numbers ?? []) {
  if (row.phone_number?.startsWith("+1") && row.phone_number.length === 12) {
    number = row.phone_number;
    numberSid = row.sid ?? "";
    break;
  }
}

if (!number) {
  const avail = await twilio<{ available_phone_numbers?: { phone_number?: string }[] }>(
    `${API}/AvailablePhoneNumbers/US/Local.json?VoiceEnabled=true&PageSize=1`,
  );
  const buy = avail.available_phone_numbers?.[0]?.phone_number;
  if (!buy) throw new Error("no US local numbers in stock");
  const created = await twilio<{ phone_number?: string; sid?: string }>(
    `${API}/IncomingPhoneNumbers.json`,
    {
      method: "POST",
      body: new URLSearchParams({
        PhoneNumber: buy,
        VoiceUrl: voiceUrl(),
        VoiceMethod: "POST",
      }),
    },
  );
  number = created.phone_number ?? buy;
  numberSid = created.sid ?? "";
  console.log("bought", number);
} else if (numberSid) {
  await twilio(`${API}/IncomingPhoneNumbers/${numberSid}.json`, {
    method: "POST",
    body: new URLSearchParams({
      VoiceUrl: voiceUrl(),
      VoiceMethod: "POST",
    }),
  });
  console.log("updated voice url", number);
}

const geo = await fetch(
  "https://voice.twilio.com/v1/DialingPermissions/BulkCountryUpdates",
  {
    method: "POST",
    headers: {
      Authorization: AUTH,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      UpdateRequest: JSON.stringify([
        {
          iso_code: "RU",
          low_risk_numbers_enabled: true,
          high_risk_special_numbers_enabled: false,
          high_risk_tollfraud_numbers_enabled: false,
        },
        {
          iso_code: "KZ",
          low_risk_numbers_enabled: true,
          high_risk_special_numbers_enabled: false,
          high_risk_tollfraud_numbers_enabled: false,
        },
      ]),
    }),
    signal: AbortSignal.timeout(20_000),
  },
);
const geoText = await geo.text();
if (!geo.ok) {
  console.log("geo permissions need console:", geo.status, geoText.slice(0, 200));
} else {
  console.log("enabled RU + KZ low-risk dialing");
}

console.log("set on Convex + Vercel (do not commit):");
console.log(`TWILIO_NUMBER=${number}`);
console.log("TWILIO_ACCOUNT_SID=<same>");
console.log("TWILIO_AUTH_TOKEN=<same>");
console.log("voice url", voiceUrl());
