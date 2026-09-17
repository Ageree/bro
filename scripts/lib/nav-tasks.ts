/**
 * Navigation task suite for the Jev-vs-Cloud benchmark.
 *
 * Why this suite exists alongside `scripts/model-bench.ts`: that one asks for
 * an answer line (`COUNT=3 SUM=132.39`) and grades the prose. `jev-ultrafast`
 * returns no prose at all — it drives the browser into a state and stops, and
 * its own AGENTS.md says "A DONE choice is not proof of success". Grading the
 * two arms on an answer string would compare a talker to a driver. So every
 * task here is graded *only* by the state of the page the agent left behind,
 * read back over CDP by the harness. Both arms do the same work and are
 * marked by the same ruler.
 *
 * Rules every task obeys, and why:
 *
 * - **One natural-language goal, shared verbatim by both arms.** No selectors,
 *   no step lists, no field names. jev-ultrafast's AGENTS.md forbids
 *   site-specific plans, and a suite that smuggles them in would measure the
 *   prompt rather than the policy.
 * - **The outcome must not be reachable by guessing a URL.** Five of the seven
 *   land on auth-gated pages or on pure in-page DOM state. A Cloud agent can
 *   type an address; Jev's action space cannot (it only clicks, types into
 *   fields, selects, scrolls and waits), so a task solvable by address-bar
 *   navigation would hand Cloud a shortcut past the thing being measured.
 * - **Ground truth computed from the live page, then frozen here.** Every
 *   value below was read out of a real browser on 2026-09-17 (see the spec at
 *   docs/superpowers/specs/2026-09-17-jev-vs-cloud-bench.md).
 * - **No famous scraping fixture.** `books.toscrape` and `quotes.toscrape` are
 *   the two most-tutorialised pages on the web and a model may recite them
 *   without looking. These sites have to be operated to be solved.
 *
 * A site that *looked* right and was rejected: `webscraper.io`'s
 * `e-commerce/allinone` page rotates its featured products — three fetches
 * gave three different sets — so its "ground truth" would silently drift.
 * The `e-commerce/static` tree is stable and is used instead.
 */

export type NavTask = {
  id: string;
  /** What the task actually stresses — printed in the plan and the report. */
  stresses: string;
  /** Page the agent starts from. */
  startUrl: string;
  /** The goal, handed to both arms word for word. */
  goal: string;
  /**
   * Origins whose cookies and storage are wiped before each attempt.
   *
   * Not optional hygiene: saucedemo keeps the cart in `localStorage`
   * (`cart-contents`) and the login in a cookie, both of which survive a tab
   * close. Measured on a reused local profile, attempt two starts already
   * logged in with attempt one's cart still in it, and every cart assertion
   * silently passes. The Cloud arm gets a fresh browser per run; the Jev arm
   * shares one long-lived Chrome, so it must be reset explicitly.
   */
  resetOrigins: string[];
  /**
   * Independent outcome check: a JS expression evaluated in the page the agent
   * finished on, returning `{ok, got}`. `got` is carried into the report so a
   * failure says what the page actually held.
   */
  check: string;
};

/** Wrap a check body so a wrong final page reports instead of throwing. */
function check(body: string): string {
  return `(() => { try { ${body} } catch (e) { return { ok: false, got: "threw: " + e.message }; } })()`;
}

const SAUCE = "https://www.saucedemo.com";
const INTERNET = "https://the-internet.herokuapp.com";
const WEBSCRAPER = "https://webscraper.io";

export const NAV_TASKS: NavTask[] = [
  {
    id: "sauce-login",
    stresses: "two-field credential form; target page is auth-gated, so it cannot be reached by typing a URL",
    startUrl: `${SAUCE}/`,
    goal: "Log in with username standard_user and password secret_sauce.",
    resetOrigins: [SAUCE],
    // Live ground truth: a good login lands on /inventory.html with six items.
    check: check(`
      const items = [...document.querySelectorAll(".inventory_item_name")].map((e) => e.textContent.trim());
      return {
        ok: location.pathname === "/inventory.html" && items.length === 6,
        got: { path: location.pathname, items: items.length },
      };
    `),
  },
  {
    id: "sauce-cart",
    stresses: "chained errand: log in, pick one named product out of six, open the cart",
    startUrl: `${SAUCE}/`,
    goal:
      "Log in with username standard_user and password secret_sauce, add the Sauce Labs Fleece Jacket " +
      "to the shopping cart, and open the shopping cart page.",
    resetOrigins: [SAUCE],
    // The cart must hold that item and *only* it: an agent that adds all six
    // and opens the cart would otherwise pass on a substring test.
    check: check(`
      const cart = [...document.querySelectorAll(".cart_item .inventory_item_name")].map((e) => e.textContent.trim());
      return {
        ok: location.pathname === "/cart.html" && cart.length === 1 && cart[0] === "Sauce Labs Fleece Jacket",
        got: { path: location.pathname, cart },
      };
    `),
  },
  {
    id: "sauce-checkout",
    stresses: "longest chain — login, add to cart, cart, checkout form of three fields, order overview",
    startUrl: `${SAUCE}/`,
    goal:
      "Log in with username standard_user and password secret_sauce, add the Sauce Labs Onesie to the " +
      "shopping cart, then go through checkout as Ivan Petrov with postal code 101000 until the order " +
      "overview page showing the payment information and the total is displayed. Do not confirm the order.",
    resetOrigins: [SAUCE],
    // Stopping on step two matters: /checkout-complete.html means it confirmed
    // an order it was told not to confirm, which is a fail, not a bonus.
    check: check(`
      const cart = [...document.querySelectorAll(".cart_item .inventory_item_name")].map((e) => e.textContent.trim());
      const total = document.querySelector(".summary_total_label")?.textContent.trim() ?? null;
      return {
        ok: location.pathname === "/checkout-step-two.html" && cart.length === 1 &&
            cart[0] === "Sauce Labs Onesie" && !!total,
        got: { path: location.pathname, cart, total },
      };
    `),
  },
  {
    id: "internet-login",
    stresses: "the same credential-form shape on a second, unrelated site — tells a capability from a one-site fluke",
    startUrl: `${INTERNET}/login`,
    goal: "Log in with username tomsmith and password SuperSecretPassword!",
    resetOrigins: [INTERNET],
    // Verified shortcut-proof: navigating straight to /secure bounces back to
    // /login with "You must login to view the secure area!".
    check: check(`
      const flash = document.querySelector("#flash")?.textContent ?? "";
      return {
        ok: location.pathname === "/secure" && flash.includes("You logged into a secure area!"),
        got: { path: location.pathname, flash: flash.trim().split("\\n")[0] },
      };
    `),
  },
  {
    id: "internet-checkboxes",
    stresses: "reading state before acting — box 1 starts clear, box 2 starts checked, so clicking both fails",
    startUrl: `${INTERNET}/checkboxes`,
    goal: "Make sure that both checkboxes on the page end up checked.",
    resetOrigins: [INTERNET],
    check: check(`
      const boxes = [...document.querySelectorAll("#checkboxes input[type=checkbox]")];
      return {
        ok: location.pathname === "/checkboxes" && boxes.length === 2 && boxes.every((b) => b.checked),
        got: { path: location.pathname, checked: boxes.map((b) => b.checked) },
      };
    `),
  },
  {
    id: "internet-dropdown",
    stresses: "a native <select> — a distinct operation, not a click",
    startUrl: `${INTERNET}/dropdown`,
    goal: "Select the option labelled 'Option 2' in the dropdown.",
    resetOrigins: [INTERNET],
    check: check(`
      const el = document.querySelector("#dropdown");
      return {
        ok: location.pathname === "/dropdown" && !!el && el.value === "2",
        got: { path: location.pathname, value: el ? el.value : null },
      };
    `),
  },
  {
    id: "webscraper-product",
    stresses: "catalogue navigation — find one named product among six cards and open its page",
    startUrl: `${WEBSCRAPER}/test-sites/e-commerce/static/computers/laptops`,
    goal: "Open the product page for the laptop named ThinkPad T540p.",
    resetOrigins: [WEBSCRAPER],
    // Live ground truth: ThinkPad T540p is /test-sites/e-commerce/static/product/33.
    check: check(`
      const title = document.querySelector("h4.card-title, .caption h4:not(.price)")?.textContent.trim() ?? "";
      return {
        ok: /\\/test-sites\\/e-commerce\\/static\\/product\\/33$/.test(location.pathname),
        got: { path: location.pathname, title },
      };
    `),
  },
];

export function taskById(id: string): NavTask | undefined {
  return NAV_TASKS.find((t) => t.id === id);
}

/**
 * What the harness evaluates to wipe an origin's client-side state. Kept here
 * so both arms reset identically.
 */
export const RESET_STORAGE_JS =
  `(() => { try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} return true; })()`;
