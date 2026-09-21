import { defineEvlogHook } from "evlog/eve";

export default defineEvlogHook({
  init: {
    env: { service: "open-instinct" },
    redact: true,
  },
  message: "omit",
  redact: true,
  sessionEvent: true,
});
