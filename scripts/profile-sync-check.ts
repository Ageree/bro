import { readFileSync } from "node:fs";
import {
  isBrowserProfileId,
  LOGIN_MARK,
  loginChatText,
  loginPageUrl,
  loginWaitTask,
  normalizeBrowserProfileId,
  pickCookieDomains,
  profileSyncStatus,
} from "../convex/lib/browserProfilePolicy.ts";
import { scaffoldTask } from "../agent/lib/browseruse.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const id = "550e8400-e29b-41d4-a716-446655440000";
assert(isBrowserProfileId(id), "uuid ok");
assert(!isBrowserProfileId("bu_not_a_profile"), "api key is not a profile");
assert(normalizeBrowserProfileId(` ${id} `) === id, "trim id");

assert(loginPageUrl("https://www.ozon.ru/login")?.startsWith("https://"), "https ok");
assert(loginPageUrl("not a url") === undefined, "junk url");
assert(loginPageUrl("ftp://x") === undefined, "ftp rejected");

const wait = loginWaitTask("https://www.ozon.ru");
assert(wait.startsWith(LOGIN_MARK), "login mark");
assert(wait.includes("https://www.ozon.ru/"), "opens the page");
assert(wait.includes("Ничего не вводи"), "never types secrets");
assert(scaffoldTask(wait) === wait, "login task not re-wrapped");

const chat = loginChatText("https://live.example/view", "Ozon");
assert(chat.includes("Открой ссылку и войди в Ozon"), "plain chat copy");
assert(chat.includes("пароль не увидит"), "no password");
assert(/\n\nhttps:\/\/live\.example\/view$/.test(chat), "url on its own line");
assert(!chat.includes("profile.sh"), "no terminal helper");
assert(!chat.includes("Profile ID"), "no profile id");

assert(profileSyncStatus({}) === "missing", "no profile");
assert(
  profileSyncStatus({ profileId: id, cookieDomains: ["ozon.ru"] }) === "synced",
  "cookies mean synced",
);
assert(
  pickCookieDomains(["ozon.ru", "ozon.ru", "wb.ru"]).join(",") === "ozon.ru,wb.ru",
  "dedupe domains",
);

const cabinet = readFileSync(new URL("../cabinet.html", import.meta.url), "utf8");
assert(cabinet.includes('id="chrome"'), "cabinet has chrome card");
assert(cabinet.includes("пришлёт ссылку в чат"), "cabinet explains the chat link");
assert(!cabinet.includes("profile.sh"), "cabinet has no terminal helper");
assert(!cabinet.includes("profile-id"), "cabinet has no profile id field");
assert(!cabinet.includes("/me/browser-profile"), "cabinet does not paste ids");

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
assert(readme.includes("texts a link"), "readme is the chat-link flow");
assert(!readme.includes("profile.sh"), "readme has no terminal helper");

const tool = readFileSync(
  new URL("../agent/tools/profile_setup.ts", import.meta.url),
  "utf8",
);
assert(tool.includes("sendBlueIMessage"), "tool texts the link itself");
assert(tool.includes("loginChatText"), "tool uses the plain copy");

console.log("profile-sync-check ok");
