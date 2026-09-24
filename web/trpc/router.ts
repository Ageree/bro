import { TRPCError } from "@trpc/server";
import { gateway } from "ai";
import { z } from "zod";
import { mintChannelLinkToken } from "@db/services/channel-identities";
import { saveChat } from "@db/services/chats";
import { replaceUserProfile } from "@db/services/user-profile";
import {
  getGoogleWorkspaceAccess,
  selectGoogleWorkspaceAccess,
  selectWorkspaceModel,
} from "@db/services/settings";
import { deleteVaultItem, saveVaultItem } from "@db/services/vault";
import { saveChatSchema } from "@shared/chat/schema";
import { cabinetAppSchema } from "@shared/composio/catalog";
import {
  disconnectConnectedApp,
  readConnectedApp,
  startConnectedAppAuthorization,
} from "@shared/composio/connected-apps";
import {
  googleWorkspaceAccessSchema,
  readGoogleWorkspaceConnection,
  revokeGoogleWorkspaceGrant,
  startGoogleWorkspaceAuthorization,
} from "@shared/google-workspace/connection";
import { telegramLinkUrl } from "@shared/identity/telegram-link";
import { modelIdSchema } from "@shared/model/id";
import { userProfileSchema } from "@shared/user-profile/schema";
import {
  vaultCreateItemSchema,
  vaultImportItemsSchema,
} from "@shared/vault/schema";
import { createTRPCRouter, protectedProcedure } from "./init";

export const appRouter = createTRPCRouter({
  chats: {
    save: protectedProcedure
      .input(saveChatSchema)
      .mutation(({ ctx, input }) => saveChat(ctx.scope, input)),
  },
  connectedApps: {
    update: protectedProcedure
      .input(
        z.object({
          action: z.enum(["connect", "disconnect"]),
          app: cabinetAppSchema,
        })
      )
      .mutation(async ({ ctx, input }) => {
        if (input.action === "disconnect") {
          await disconnectConnectedApp(input.app, ctx.scope.userId);
          return { redirectTo: "/workspace" };
        }
        // The cabinet offers connecting only while no account exists, so a
        // live one means the page is stale.
        const current = await readConnectedApp(input.app, ctx.scope.userId);
        if (current.state === "connected") {
          throw new TRPCError({
            code: "CONFLICT",
            message: "The app is already connected; disconnect it first.",
          });
        }
        const callbackUrl = new URL("/workspace", ctx.origin);
        callbackUrl.searchParams.set("app", input.app);
        return {
          redirectTo: await startConnectedAppAuthorization(
            input.app,
            ctx.scope.userId,
            callbackUrl.toString()
          ),
        };
      }),
  },
  googleWorkspace: {
    update: protectedProcedure
      .input(
        z.discriminatedUnion("action", [
          z.object({
            access: googleWorkspaceAccessSchema,
            action: z.literal("connect"),
          }),
          z.object({ action: z.literal("disconnect") }),
        ])
      )
      .mutation(async ({ ctx, input }) => {
        if (input.action === "disconnect") {
          await revokeGoogleWorkspaceGrant(ctx.scope.userId);
          return { redirectTo: "/workspace?google=disconnected" };
        }

        // A new flow never starts over a live account: the old grant would
        // stay behind under the new one. The cabinet offers a level only
        // while no account exists, so this answers a stale page.
        const current = await readGoogleWorkspaceConnection(
          ctx.scope.userId,
          await getGoogleWorkspaceAccess(ctx.scope)
        );
        if (current.state === "connected") {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Google is already connected; disconnect it first.",
          });
        }
        await selectGoogleWorkspaceAccess(ctx.scope, input.access);
        const callbackUrl = new URL("/workspace", ctx.origin);
        callbackUrl.searchParams.set("google", "connected");
        return {
          redirectTo: await startGoogleWorkspaceAuthorization(
            ctx.scope.userId,
            input.access,
            callbackUrl.toString()
          ),
        };
      }),
  },
  telegram: {
    link: protectedProcedure.mutation(async ({ ctx }) => ({
      url: telegramLinkUrl(await mintChannelLinkToken(ctx.scope, "telegram")),
    })),
  },
  settings: {
    selectModel: protectedProcedure
      .input(z.object({ modelId: modelIdSchema }))
      .mutation(({ ctx, input }) =>
        selectWorkspaceModel(ctx.scope, input.modelId)
      ),
  },
  userProfile: {
    update: protectedProcedure
      .input(userProfileSchema)
      .output(userProfileSchema)
      .mutation(({ ctx, input }) => replaceUserProfile(ctx.scope, input)),
  },
  vault: {
    create: protectedProcedure
      .input(vaultCreateItemSchema)
      .mutation(({ ctx, input }) => saveVaultItem(ctx.scope, input)),
    import: protectedProcedure
      .input(vaultImportItemsSchema)
      .mutation(async ({ ctx, input }) => {
        /* oxlint-disable eslint/no-await-in-loop -- Import preserves source order and avoids concurrent writes to the same vault scope. */
        for (const item of input) await saveVaultItem(ctx.scope, item);
        /* oxlint-enable eslint/no-await-in-loop */
      }),
    remove: protectedProcedure
      .input(z.object({ id: z.string().min(1) }))
      .mutation(({ ctx, input }) => deleteVaultItem(ctx.scope, input.id)),
  },
  models: {
    list: protectedProcedure.query(readModelCatalog),
  },
});

export type AppRouter = typeof appRouter;

async function readModelCatalog() {
  const { models } = await gateway.getAvailableModels();

  return z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        ownedBy: z.string(),
        pricing: z
          .object({
            input: z.number().nonnegative().optional(),
            output: z.number().nonnegative().optional(),
          })
          .optional(),
      })
    )
    .parse(
      models
        .filter((model) => model.modelType === "language")
        .map((model) => ({
          id: model.id,
          name: model.name,
          ownedBy: model.specification.provider,
          pricing: model.pricing
            ? {
                input: perMillion(model.pricing.input),
                output: perMillion(model.pricing.output),
              }
            : undefined,
        }))
    );
}

function perMillion(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed * 1_000_000 : undefined;
}
