import { randomInt } from "node:crypto";
import { type Browser, test } from "@e2e-dev/web";
import { type App, expect, type Screen } from "e2e";

/**
 * A Russian mobile number nobody has used yet: each sign-in is a new person,
 * so runs and retries never meet each other's data.
 */
export function newPhone() {
  const digits = String(randomInt(0, 10_000_000)).padStart(7, "0");
  return `+7999${digits}`;
}

/**
 * The local sign-in: `next dev` on a loopback URL takes any phone without a
 * code (`LocalPhoneAuthForm`). Ends on the page the sign-in returns to.
 */
export async function signIn(
  { browser, screen }: { browser: Browser; screen: Screen },
  phone: string,
  returnsTo = "/workspace"
) {
  await screen.getByLabel("Телефон").fill(phone);
  await screen.getByRole("button", "Войти").tap();
  await expect(browser).toHaveURL(returnsTo);
}

/**
 * For tests that change what a person has (profile, vault, settings): the
 * shared `person` session is read by tests running alongside, so a change
 * there would race them. The fixture signs in a person of the test's own.
 */
export const ownPersonTest = test.extend<{ phone: string }>({
  phone: async (
    { app, browser, screen }: { app: App; browser: Browser; screen: Screen },
    provide: (phone: string) => Promise<void>
  ) => {
    const phone = newPhone();
    await app.open("/sign-in");
    await signIn({ browser, screen }, phone);
    await provide(phone);
  },
});
