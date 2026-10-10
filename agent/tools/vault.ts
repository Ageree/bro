import { defineDynamic, defineTool } from "eve/tools";
import { resolveModeValue } from "@agent/lib/mode";
import { applicationOrigin } from "@shared/environment/origin";
import {
  createVaultSetupUrl,
  vaultSetupRequestSchema,
} from "@shared/vault/schema";

// Logins have no page here: a person signs in themselves through
// `site-login-link`, says the login in the chat (`login` of `browser_task`)
// or has Bro sign up with its own mailbox (docs/login-handoff.md).
export const requestVaultSetup = defineTool({
  description:
    "Create a safe link for adding one supported item to the encrypted vault. Supported kinds are payment (card details), address (structured delivery or billing address), and contact (name, email, and phone); the request takes only kind and an optional label. Never put a secret in this setup request. Use ordinary non-secret contact details directly when the user supplied them in chat. This tool does not set up logins for websites: when a site needs a password, offer the person to sign in themselves through a link (site-login-link), to say the login and password in the chat, or to have Bro sign up on its own.",
  inputSchema: vaultSetupRequestSchema,
  execute(request) {
    return {
      message:
        "Открой эту ссылку и заполни форму там. Секрет в чат не присылай.",
      url: createVaultSetupUrl(applicationOrigin(), request),
    };
  },
});

export default defineDynamic({
  events: {
    "turn.started": (_event, context) =>
      resolveModeValue(context, {
        interactive: { request_vault_setup: requestVaultSetup },
        "scheduled-report": { request_vault_setup: requestVaultSetup },
      }),
  },
});
