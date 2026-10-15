import { defineChannel, POST } from "eve/channels";
import {
  receiveLiveLocation,
  telegramLocationPath,
} from "@agent/lib/location/live";

/**
 * The door for a Telegram live location's edits, which eve's own Telegram
 * channel drops (`agent/lib/location/live.ts`). The VM's bridge posts them
 * here with the webhook's secret; no conversation starts here.
 */
export default defineChannel({
  audience() {
    return "unknown";
  },
  receive() {
    throw new Error("The live location channel only serves its route.");
  },
  routes: [
    POST(
      telegramLocationPath,
      async (request) => await receiveLiveLocation(request)
    ),
  ],
});
