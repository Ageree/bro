import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const token = "123456:test-bot-token";
const now = Date.UTC(2026, 9, 19, 22, 0);

/** Launch data as Telegram signs it for a Mini App Bro's button opened. */
function launchData(
  fields: Readonly<Record<string, string>>,
  botToken = token
) {
  const checked = Object.entries(fields)
    .toSorted(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(checked).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

const fields = {
  auth_date: String(Math.floor(now / 1000) - 60),
  query_id: "AAHdF6IQAAAAAN0XohDhrOrc",
  user: JSON.stringify({ id: 4242, first_name: "Алиса" }),
};

async function load() {
  vi.resetModules();
  return import("@app/api/yoomoney/onboarding/[id]/telegram");
}

beforeEach(() => {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", token);
});

describe("Telegram's launch data", () => {
  it("names the chat's user only when Telegram signed it with Bro's bot token, lately", async () => {
    const { telegramWebAppUser } = await load();
    expect(telegramWebAppUser(launchData(fields), now)).toBe("4242");
    // Another bot's data, a changed user, or a day-old launch prove nothing.
    expect(
      telegramWebAppUser(launchData(fields, "999:other-bot"), now)
    ).toBeUndefined();
    expect(
      telegramWebAppUser(launchData(fields).replace("4242", "4243"), now)
    ).toBeUndefined();
    expect(
      telegramWebAppUser(launchData(fields), now + 25 * 60 * 60_000)
    ).toBeUndefined();
    expect(telegramWebAppUser("", now)).toBeUndefined();
  });
});
