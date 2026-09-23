export const browserEvalFixtures = {
  "github-amended-search": {
    continuation:
      "Change only the keyword from terminal to notebook. Retain the microsoft/vscode repository, open state, bug label, count of three, newest-updated-first ordering, and exact issue URL requirement. Use the current browser session and report the amended result with fresh evidence.",
    criteria: [
      "The initial result contains exactly three microsoft/vscode issues.",
      "Every initial issue is open, labeled bug, mentions terminal, and has an exact issue URL and updated date.",
      "The continuation changes only the keyword to notebook and retains all other constraints.",
      "The continuation contains fresh exact issue URLs and does not reuse unsupported initial facts.",
    ],
    task: "On GitHub, search issues in microsoft/vscode and find exactly three currently open issues labeled bug that mention terminal. Order them by most recently updated. Verify each issue page and report its title, updated date, and exact issue URL. Do not sign in, post, react, or change anything.",
  },
  "lisbon-hotels": {
    continuation: undefined,
    criteria: [
      "Exactly three Lisbon hotels are compared for two adults, October 16–18, 2026.",
      "Every candidate is at most €400 total, has a private bathroom, and has a refundable option.",
      "Total including taxes/fees and cancellation terms were verified on an actual hotel or booking detail page.",
      "Every factual candidate claim has an exact public source URL; any missing criterion is marked partial.",
    ],
    task: "Compare three Lisbon hotels for two adults staying October 16–18, 2026. Each must cost no more than €400 total, have a private bathroom, and offer a refundable option. Verify the total including taxes and fees and the cancellation terms on an actual hotel or booking detail page. Report exact public URLs and clearly mark the result partial if any criterion cannot be verified. Do not log in, reserve, enter guest details, or begin checkout.",
  },
  "rei-daypacks": {
    continuation: undefined,
    criteria: [
      "Exactly three REI hiking daypacks are currently in stock, 20–30 L, and no more than $150.",
      "Hydration compatibility, capacity, product variant availability, and current price are verified on each product page.",
      "The result ranks the three options with concrete tradeoffs.",
      "Every product has an exact public REI URL and no cart or checkout action occurred.",
    ],
    task: "On REI, find exactly three currently in-stock hiking daypacks with 20–30 L capacity, price no more than $150, and hydration compatibility. Verify the product variant availability, capacity/specification, current price, and hydration compatibility on each product page. Rank the three with concise tradeoffs and report exact public product URLs. Do not add anything to a cart, sign in, or begin checkout.",
  },
} as const;

export const browserEvalTaskIds = Object.keys(browserEvalFixtures);
