import { defineDynamic, defineTool, type ToolContext } from "eve/tools";
import { z } from "zod";
import { selectBrowserVaultItems } from "@agent/lib/browser-use/secrets";
import { resolveModeValue } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { readVaultItems } from "@db/services/vault";
import { applicationOrigin } from "@shared/environment/origin";
import {
  createVaultSetupUrl,
  vaultSetupRequestSchema,
} from "@shared/vault/schema";

export const requestVaultImport = defineTool({
  description:
    "Create a direct link to the person's workspace for bulk-importing login credentials from a Chrome or Google Password Manager CSV into the encrypted vault. Use this when the user wants to import or migrate multiple browser passwords. Never ask them to send the CSV or any password in chat.",
  inputSchema: z.object({}),
  execute() {
    return {
      message:
        "Открой эту ссылку — там объясняется, как выгрузить пароли из Chrome, и сразу откроется безопасный импорт. Пароли в чат не присылай.",
      url: new URL("/vault?import=chrome", applicationOrigin()).toString(),
    };
  },
});

/**
 * Whether the vault already holds a sign-in a browser run on this site would
 * use. A model that did not read `boundSecrets` told the person their
 * Госуслуги login was missing and sent this link twice, while the run was
 * signing in with it (RU 24.09, d06).
 */
async function savedLoginFor(context: ToolContext, origin: string) {
  const caller = context.session.auth.current ?? context.session.auth.initiator;
  if (caller?.principalType !== "user") return undefined;
  try {
    const items = await readVaultItems(scopeFromPrincipal(caller));
    const selected = selectBrowserVaultItems(items, {
      allowPayment: false,
      site: origin,
    });
    if (selected.loginId !== undefined) return "site" as const;
    return selected.gosuslugiLoginId === undefined
      ? undefined
      : ("gosuslugi" as const);
  } catch (error) {
    console.warn("[vault] saved logins could not be read", { cause: error });
    return undefined;
  }
}

const savedLoginNote =
  "The vault already holds a login for this site, and a browser run on it signs in with it by itself. Do not send this link and do not tell the user their login is missing. Send it only when a run reported the saved password was rejected (Needs: password on a run that had it bound) or the user asked to replace it — and then say it replaces the saved one.";

/**
 * mos.ru, the tax service, Мосэнергосбыт and ЕМИАС let a person in with
 * their Госуслуги account, and a run on them gets the Госуслуги login from
 * the vault: a separate password for them is not missing (RU 24.09, d07).
 */
const gosuslugiLoginNote =
  "The vault holds the user's Госуслуги login, and this site signs people in through Госуслуги («Войти через Госуслуги»): a browser run on it signs in with that login by itself. Do not send this link and do not tell the user a login for this site is missing. Send it only when a run on this site reported Needs: password although the Госуслуги login was bound, or the user asked to save this site's own password.";

export const requestVaultSetup = defineTool({
  description:
    "Create a safe link for adding one supported item to the encrypted vault. Supported kinds are login (email, phone, or username with a password or one-time-code method), payment (card details), address (structured delivery or billing address), and contact (name, email, and phone). A login setup requires a descriptive label, identifierType, and the exact current website origin; the user enters the actual identifier and secret on the vault page. Other kinds accept only kind and an optional label. Never put an email address, phone number, username, or secret in this setup request. Use ordinary non-secret contact details directly when the user supplied them in chat. A browser_task result whose boundSecrets include login_username already signs in with the saved login, and one with gosuslugi_username signs in through Госуслуги: do not ask for it again. A saved Госуслуги login also opens mos.ru, ЕМИАС, the tax service's personal account, Мосэнергосбыт and other public-service sites with «Войти через Госуслуги».",
  inputSchema: vaultSetupRequestSchema,
  async execute(request, context) {
    const url = createVaultSetupUrl(applicationOrigin(), request);
    const saved =
      request.kind === "login"
        ? await savedLoginFor(context, request.origin)
        : undefined;
    if (saved !== undefined) {
      return {
        alreadySaved: true,
        note: saved === "site" ? savedLoginNote : gosuslugiLoginNote,
        url,
      };
    }
    return {
      message:
        "Открой эту ссылку и заполни форму там. Секрет в чат не присылай.",
      url,
    };
  },
});

export default defineDynamic({
  events: {
    "turn.started": (_event, context) =>
      resolveModeValue(context, {
        interactive: {
          request_vault_import: requestVaultImport,
          request_vault_setup: requestVaultSetup,
        },
        "scheduled-report": { request_vault_setup: requestVaultSetup },
      }),
  },
});
