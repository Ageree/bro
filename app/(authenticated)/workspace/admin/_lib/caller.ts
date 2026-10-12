import { TRPCError } from "@trpc/server";
import { notFound } from "next/navigation";
import { requireRequestScope } from "@web/auth/request-scope";
import { appRouter } from "@web/trpc/router";

/**
 * Runs an owner query for a page. The same procedure guard as the tRPC route
 * decides: anyone not on the list gets the 404 page, not a refusal.
 */
export async function adminQuery<Result>(
  run: (
    admin: ReturnType<typeof appRouter.createCaller>["admin"]
  ) => Promise<Result>
) {
  const scope = await requireRequestScope();
  try {
    return await run(appRouter.createCaller({ origin: "", scope }).admin);
  } catch (error) {
    if (error instanceof TRPCError && error.code === "NOT_FOUND") notFound();
    throw error;
  }
}
