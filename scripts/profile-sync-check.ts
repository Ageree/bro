import { readFileSync } from "node:fs";
import {
  createProfileSetupUrl,
  isBrowserProfileId,
  normalizeBrowserProfileId,
  pickCookieDomains,
  PROFILE_SYNC_DOCS,
  PROFILE_SYNC_SCRIPT,
  profileSyncCommand,
  profileSyncStatus,
} from "../convex/lib/browserProfilePolicy.ts";
import { scaffoldTask } from "../agent/lib/browseruse.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const id = "550e8400-e29b-41d4-a716-446655440000";
assert(isBrowserProfileId(id), "uuid ok");
assert(isBrowserProfileId(id.toUpperCase()), "uuid case");
assert(!isBrowserProfileId("bu_not_a_profile"), "api key is not a profile");
assert(!isBrowserProfileId(""), "empty id");
assert(normalizeBrowserProfileId(` ${id} `) === id, "trim id");
assert(normalizeBrowserProfileId("nope") === undefined, "reject junk");

assert(profileSyncStatus({}) === "missing", "no profile");
assert(profileSyncStatus({ profileId: id }) === "empty", "id without cookies");
assert(
  profileSyncStatus({ profileId: id, cookieDomains: ["https://www.ozon.ru"] }) ===
    "synced",
  "cookies mean synced",
);

assert(
  pickCookieDomains(["ozon.ru", " ", 1, "ozon.ru", "wb.ru"]).join(",") ===
    "ozon.ru,wb.ru",
  "dedupe domains",
);

const cmd = profileSyncCommand();
assert(cmd.includes(PROFILE_SYNC_SCRIPT), "official script");
assert(cmd.includes("BROWSER_USE_API_KEY"), "exports key");
assert(!cmd.includes("bu_live"), "placeholder, not a live key");
assert(PROFILE_SYNC_DOCS.includes("profile-sync"), "docs url");

const setup = createProfileSetupUrl("https://bro-agent.vercel.app");
assert(setup.includes("/cabinet.html"), "cabinet path");
assert(setup.endsWith("#chrome"), "chrome hash");

const synced = scaffoldTask("зайди в заказы на ozon", { profileSynced: true });
assert(synced.includes("cookies"), "synced scaffold mentions cookies");
assert(!synced.includes("он подключится через live-URL"), "no live-url login");
const bare = scaffoldTask("найди скотч");
assert(bare.includes("синхронизированные cookies"), "unsynced points at sync");
assert(scaffoldTask(synced) === synced, "scaffold still idempotent");

const cabinet = readFileSync(new URL("../cabinet.html", import.meta.url), "utf8");
assert(cabinet.includes('id="chrome"'), "cabinet has chrome card");
assert(cabinet.includes("/me/browser-profile"), "cabinet posts profile id");
assert(cabinet.includes("profile.sh"), "cabinet shows official helper");
assert(
  !cabinet.includes("export BROWSER_USE_API_KEY=bu_"),
  "cabinet does not embed a real key",
);

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
assert(readme.includes("profile.sh"), "readme documents official helper");
assert(readme.includes("BROWSER_USE_PROFILE_ID"), "readme has profile env");

console.log("profile-sync-check ok");
