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
import {
  forgetMemory,
  listCurrentMemories,
  listMemoryScopeKeys,
  restoreMemory,
  updateMemory,
  wipeForgottenMemoryHistory,
} from "@db/services/memory/records";
import { listMemoryRecordHistory } from "@db/services/memory/revisions";
import { memoryIndexSchema, memoryTextSchema } from "@shared/memory/schema";
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

/** An eve memory scope key, as the cabinet page received it. */
const scopeKeySchema = z.string().min(1).max(512);

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
  /**
   * Profile memory in the cabinet. The person reads, corrects and forgets
   * any memory and brings back an earlier text; a rule is set or changed
   * only in their own conversation with Bro — stating one there also
   * narrows the spend limit and standing permissions — so here a rule can
   * only be read and forgotten.
   */
  memory: {
    history: protectedProcedure
      .input(z.object({ index: memoryIndexSchema, scopeKey: scopeKeySchema }))
      .query(async ({ ctx, input }) => {
        const scopeKey = await cabinetScopeKey(
          ctx.scope.workspaceId,
          input.scopeKey
        );
        return listMemoryRecordHistory(
          ctx.scope.workspaceId,
          scopeKey,
          input.index
        );
      }),
    remove: protectedProcedure
      .input(
        z.object({
          expectedRevision: z.number().int().positive(),
          index: memoryIndexSchema,
          scopeKey: scopeKeySchema,
        })
      )
      .mutation(async ({ ctx, input }) => {
        const scopeKey = await cabinetScopeKey(
          ctx.scope.workspaceId,
          input.scopeKey
        );
        await memoryWrite(() =>
          forgetMemory(
            ctx.scope,
            scopeKey,
            { expectedRevision: input.expectedRevision, index: input.index },
            `cabinet:${crypto.randomUUID()}`,
            { actor: "person" }
          )
        );
        // The last memory gone leaves no text in history either.
        if ((await listCurrentMemories(ctx.scope, scopeKey)).length === 0) {
          await wipeForgottenMemoryHistory(ctx.scope, scopeKey);
        }
      }),
    restore: protectedProcedure
      .input(
        z.object({
          expectedRevision: z.number().int().positive(),
          index: memoryIndexSchema,
          revision: z.number().int().positive(),
          scopeKey: scopeKeySchema,
        })
      )
      .mutation(async ({ ctx, input }) => {
        const scopeKey = await cabinetScopeKey(
          ctx.scope.workspaceId,
          input.scopeKey
        );
        await memoryWrite(() =>
          restoreMemory(
            ctx.scope,
            scopeKey,
            {
              expectedRevision: input.expectedRevision,
              index: input.index,
              revision: input.revision,
            },
            `cabinet:${crypto.randomUUID()}`
          )
        );
      }),
    update: protectedProcedure
      .input(
        z.object({
          expectedRevision: z.number().int().positive(),
          index: memoryIndexSchema,
          scopeKey: scopeKeySchema,
          text: memoryTextSchema,
        })
      )
      .mutation(async ({ ctx, input }) => {
        const scopeKey = await cabinetScopeKey(
          ctx.scope.workspaceId,
          input.scopeKey
        );
        const current = (await listCurrentMemories(ctx.scope, scopeKey)).find(
          ({ index }) => index === input.index
        );
        if (!current?.content || current.revision !== input.expectedRevision) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Memory changed. Open the page again.",
          });
        }
        if (current.content.category === "rule") {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "A rule is changed only in a conversation with Bro.",
          });
        }
        // The old aliases name what the person just corrected away.
        const content = { ...current.content, aliases: [], text: input.text };
        await memoryWrite(() =>
          updateMemory(
            ctx.scope,
            scopeKey,
            {
              content,
              expectedRevision: input.expectedRevision,
              index: input.index,
            },
            `cabinet:${crypto.randomUUID()}`,
            { action: "update", actor: "person" }
          )
        );
      }),
  },
});

/**
 * The scope the page showed, only if it is this workspace's: a write goes to
 * what the person saw, even when a conversation has since recalled another.
 */
async function cabinetScopeKey(workspaceId: string, scopeKey: string) {
  if (!(await listMemoryScopeKeys(workspaceId)).includes(scopeKey)) {
    throw new TRPCError({ code: "NOT_FOUND", message: "No such memory." });
  }
  return scopeKey;
}

/**
 * Runs a memory write the page may have raced: a memory changed since the
 * page read it, or a text the filter refuses, comes back as a TRPC error
 * the page shows, not a crash.
 */
async function memoryWrite<Result>(write: () => Promise<Result>) {
  try {
    return await write();
  } catch (error) {
    if (!(error instanceof Error) || error.message === "") throw error;
    throw new TRPCError({
      cause: error,
      code: /changed|forgotten/u.test(error.message)
        ? "CONFLICT"
        : "BAD_REQUEST",
      message: error.message,
    });
  }
}

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
