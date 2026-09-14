import {
  isBrowserProfileId,
  isLoginVaultTask,
  isLoginWaitTask,
  LOGIN_MARK,
  LOGIN_VAULT_MARK,
  loginChatText,
  loginPageUrl,
  loginVaultChatText,
  loginVaultTask,
  loginWaitTask,
  normalizeBrowserProfileId,
  pickCookieDomains,
  profileSyncStatus,
} from "../convex/lib/browserProfilePolicy.ts";
import {
  liveUrlFromEvents,
  shouldSendLoginLink,
} from "../convex/lib/browserLivePolicy.ts";
import { scaffoldTask } from "../agent/lib/browseruse.ts";

import { assert, src } from "./lib/check.ts";

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
assert(isLoginWaitTask(wait), "wait is a live-view login");
assert(scaffoldTask(wait) === wait, "login task not re-wrapped");

const vaultTask = loginVaultTask("https://taxi.yandex.ru");
assert(vaultTask.startsWith(LOGIN_VAULT_MARK), "vault login mark");
assert(isLoginVaultTask(vaultTask), "vault task detected");
assert(!isLoginWaitTask(vaultTask), "vault task is not a live-view wait");
assert(scaffoldTask(vaultTask) === vaultTask, "vault task not re-wrapped");
assert(vaultTask.includes("site_login"), "vault task names login alias");
assert(vaultTask.includes("site_password"), "vault task names password alias");
assert(!vaultTask.includes("ochen"), "vault task has no secret");

const chat = loginChatText("https://live.example/view", "Ozon");
assert(chat.includes("Открой ссылку и войди в Ozon"), "plain chat copy");
assert(chat.includes("пароль не увидит"), "no password");
assert(/\n\nhttps:\/\/live\.example\/view$/.test(chat), "url on its own line");
assert(!chat.includes("profile.sh"), "no terminal helper");
assert(!chat.includes("Profile ID"), "no profile id");

const vaultChat = loginVaultChatText("Ozon");
assert(vaultChat.includes("войду в Ozon входом из сейфа"), "vault chat copy");
assert(!vaultChat.includes("http"), "vault chat has no url");
assert(!vaultChat.includes("пароль"), "vault chat does not say password");

assert(
  liveUrlFromEvents({
    events: [
      { type: "browser.ready", data: { live_view_url: "https://live.example/view" } },
    ],
  }) === "https://live.example/view",
  "events live_view_url",
);
assert(
  liveUrlFromEvents({
    events: [{ type: "browser.ready", data: { liveViewUrl: "https://live.example/camel" } }],
  }) === "https://live.example/camel",
  "events camelCase liveViewUrl",
);
assert(
  shouldSendLoginLink({
    loginWait: true,
    liveUrl: "https://live.example/view",
  }),
  "send live link on wait",
);
assert(
  !shouldSendLoginLink({
    loginWait: false,
    liveUrl: "https://live.example/view",
  }),
  "do not send live link on vault login",
);

assert(profileSyncStatus({}) === "missing", "no profile");
assert(
  profileSyncStatus({ profileId: id, cookieDomains: ["ozon.ru"] }) === "synced",
  "cookies mean synced",
);
assert(
  pickCookieDomains(["ozon.ru", "ozon.ru", "wb.ru"]).join(",") === "ozon.ru,wb.ru",
  "dedupe domains",
);

const cabinet = src("cabinet.html");
assert(cabinet.includes('id="chrome"'), "cabinet has chrome card");
assert(cabinet.includes("пришлёт ссылку в чат"), "cabinet explains the chat link");
assert(cabinet.includes("вход из сейфа"), "cabinet mentions the vault login");
assert(cabinet.includes("/vault.html?kind=login"), "cabinet can add a login");
assert(!cabinet.includes("profile.sh"), "cabinet has no terminal helper");
assert(!cabinet.includes("profile-id"), "cabinet has no profile id field");
assert(!cabinet.includes("/me/browser-profile"), "cabinet does not paste ids");

const readme = src("README.md");
assert(readme.includes("texts a live-view link"), "readme is the chat-link flow");
assert(readme.includes("kind: login"), "readme mentions vault logins");
assert(!readme.includes("asks them for the password"), "readme never asks in chat");
assert(!readme.includes("profile.sh"), "readme has no terminal helper");

const tool = src("agent/tools/profile_setup.ts");
assert(tool.includes("deliverHuman"), "tool texts the link itself");
assert(tool.includes("loginChatText"), "tool uses the plain copy");
assert(tool.includes("vaultPasswordLogin"), "tool reads the vault first");
assert(tool.includes("loginVaultTask"), "tool starts a vault login run");
assert(tool.includes("NO_PASSWORD_HINT") || tool.includes("Не проси"), "never ask for a password");

const vaultTool = src("agent/tools/vault_setup.ts");
assert(vaultTool.includes("kind=login") || vaultTool.includes("site login"), "vault_setup can mint a login page");

const follow = src("convex/browserFollow.ts");
assert(follow.includes("isLoginWaitTask"), "follow sends the live link only for wait tasks");
assert(follow.includes("shouldSendLoginLink"), "follow uses the live-link gate");

console.log("profile-sync-check ok");
