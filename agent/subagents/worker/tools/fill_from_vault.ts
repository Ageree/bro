import { defineTool } from "eve/tools";
import { z } from "zod";
import { listVaultItems } from "../../../lib/convex";
import { nativeAutofillTokens } from "../lib/autofill/claims";
import {
  currentKernelPageOrigin,
  fillWithKernelNativeAutofill,
} from "../lib/autofill/native";
import { vaultAutofillProvider } from "../lib/autofill/provider";
import { materializeAutofillClaims } from "../lib/autofill/service";
import { kernel } from "../lib/kernel";
import { requireOwnedBrowser } from "../lib/scope";

const inputSchema = z.object({
  browserSessionId: z.string().trim().min(1).max(500),
  candidateId: z.string().trim().min(1).max(500),
});

const outputSchema = z.object({
  filledClaims: z.number().int().nonnegative(),
  kind: z.enum(["address", "login", "payment"]),
  origin: z.string(),
  success: z.literal(true),
});

export default defineTool({
  description:
    "Fill a login, card, or address form with an opaque handle returned by list_vault. Focus one control in the intended form first. Never supply vault fields, selectors, origins, or secret values.",
  inputSchema,
  outputSchema,
  async execute(input, context) {
    const { phone } = await requireOwnedBrowser(context, input.browserSessionId);
    const items = await listVaultItems(phone);
    const item = items.find((candidate) => candidate.handle === input.candidateId);
    if (!item) throw new Error("The selected vault item was not found.");
    if (item.kind === "contact") {
      throw new Error(
        "Native Chromium autofill does not support contact records. Type the non-secret contact values (name, email, phone) into the form directly."
      );
    }
    if (item.kind === "login") {
      const browser = await kernel().browsers.retrieve(
        input.browserSessionId,
        {},
        { signal: context.abortSignal }
      );
      if (!browser.profile_save_changes) {
        throw new Error(
          "Login autofill requires a browser created with save_changes: true. Delete this browser, create a writable browser at the same URL, then focus and fill again."
        );
      }
    }

    const origin = await currentKernelPageOrigin({
      browserSessionId: input.browserSessionId,
      signal: context.abortSignal,
    });
    const surfaceKind =
      item.kind === "payment"
        ? "payment-card"
        : item.kind === "login"
          ? "credentials"
          : "postal-address";
    const tokens = nativeAutofillTokens[item.kind];
    const surface = {
      fields: tokens.map((token) => ({ score: 100, token })),
      id: surfaceKind,
      kind: surfaceKind,
    };

    const claims = await materializeAutofillClaims(
      phone,
      input.candidateId,
      {
        availableTokens: new Set(tokens),
        origin,
        surface,
      },
      vaultAutofillProvider
    );
    const result = await fillWithKernelNativeAutofill({
      browserSessionId: input.browserSessionId,
      claims,
      expectedOrigin: origin,
      kind: item.kind,
      signal: context.abortSignal,
    });

    return {
      filledClaims: result.filledClaims,
      kind: item.kind,
      origin: result.origin,
      success: true as const,
    };
  },
});
