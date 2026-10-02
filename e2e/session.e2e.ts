import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { newPhone, signIn } from "./person.ts";

/**
 * Signs in once for every test that declares `session: "person"`, as a
 * person Bro has never met. Tests on this session share one account: they
 * only read it or add what no other test reads (`ownPersonTest` otherwise).
 */
test.setup(
  "a new person signs in",
  { sessions: ["person"] },
  async ({ app, browser, screen, session }) => {
    await app.open("/sign-in");
    await signIn({ browser, screen }, newPhone());
    await expect(screen.getByRole("heading", "Кабинет")).toBeVisible();

    // `next dev` compiles a route on its first visit; doing it here keeps
    // that wait out of the tests that time their own steps.
    // Each route's own heading: any heading would pass on the error page.
    for (const [path, heading] of [
      ["/personal-info", "Личные данные"],
      ["/vault", "Сейф"],
      ["/chat", "Чат"],
      ["/chat/history", "Все чаты"],
    ] as const) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one tab visits the routes in turn.
      await app.open(path);
      // oxlint-disable-next-line eslint/no-await-in-loop -- see above.
      await expect(
        screen.getByRole("heading", heading, { level: 1 })
      ).toBeVisible();
    }

    await session.save("person");
  }
);
