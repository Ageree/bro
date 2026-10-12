import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { createHTTPContext } from "@web/trpc/http-context";
import { appRouter } from "@web/trpc/router";

const handler = (request: Request) =>
  fetchRequestHandler({
    createContext: () => createHTTPContext(request),
    endpoint: "/api/trpc",
    req: request,
    // A vault answer — a login read back above all — and the owner's pages,
    // with people's turns and texts, are never kept by a browser or a proxy.
    responseMeta: ({ info }) =>
      info?.calls.some(
        (call) =>
          call.path.startsWith("vault.") || call.path.startsWith("admin.")
      ) === true
        ? { headers: { "cache-control": "no-store" } }
        : {},
    router: appRouter,
  });

export { handler as GET, handler as POST };
