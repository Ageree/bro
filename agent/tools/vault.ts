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
  if (caller?.principalType !== "user") return false;
  try {
    const items = await readVaultItems(scopeFromPrincipal(caller));
    return (
      selectBrowserVaultItems(items, { allowPayment: false, site: origin })
        .loginId !== undefined
    );
  } catch (error) {
    console.warn("[vault] saved logins could not be read", { cause: error });
    return false;
  }
}

const savedLoginNote =
  "The vault already holds a login for this site, and a browser run on it signs in with it by itself. Do not send this link and do not tell the user their login is missing. Send it only when a run reported the saved password was rejected (Needs: password on a run that had it bound) or the user asked to replace it — and then say it replaces the saved one.";

export const requestVaultSetup = defineTool({
  description:
    "Create a safe link for adding one supported item to the encrypted vault. Supported kinds are login (email, phone, or username with a password or one-time-code method), payment (card details), address (structured delivery or billing address), and contact (name, email, and phone). A login setup requires a descriptive label, identifierType, and the exact current website origin; the user enters the actual identifier and secret on the vault page. Other kinds accept only kind and an optional label. Never put an email address, phone number, username, or secret in this setup request. Use ordinary non-secret contact details directly when the user supplied them in chat. A browser_task result whose boundSecrets include login_username already signs in with the saved login: do not ask for it again.",
  inputSchema: vaultSetupRequestSchema,
  async execute(request, context) {
    const url = createVaultSetupUrl(applicationOrigin(), request);
    if (
      request.kind === "login" &&
      (await savedLoginFor(context, request.origin))
    ) {
      return { alreadySaved: true, note: savedLoginNote, url };
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
