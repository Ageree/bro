import { defineChannel, GET, POST } from "eve/channels";
import { sandboxFilesPath, sharedFileLocation } from "@agent/lib/sandbox/files";
import {
  answerSandboxToolRequest,
  sandboxToolsPath,
} from "@agent/lib/sandbox/router";

/** A link's name segment, or undefined for a malformed one (a lone `%`). */
function decodedSegment(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/**
 * The code sandbox's two doors into Bro (`sandbox/README.md`): the tool
 * router, where the `tools` CLI's GraphQL requests arrive through the host's
 * `sandboxd` with the bearer token it adds, and the links of the files the
 * task agent shared, signed one object each. No conversation starts here.
 */
export default defineChannel({
  audience() {
    return "unknown";
  },
  receive() {
    throw new Error("The sandbox channel only serves its routes.");
  },
  routes: [
    POST(
      sandboxToolsPath,
      async (request) => await answerSandboxToolRequest(request)
    ),
    GET(`${sandboxFilesPath}/:id/:name`, async (request, { params }) => {
      const name = decodedSegment(params.name ?? "");
      const location =
        name === undefined
          ? undefined
          : sharedFileLocation({
              id: params.id ?? "",
              name,
              signature: new URL(request.url).searchParams.get("sig"),
            });
      if (location === undefined) return new Response(null, { status: 404 });
      return await Promise.resolve(
        new Response(null, {
          headers: { "cache-control": "private, no-store", location },
          status: 302,
        })
      );
    }),
  ],
});
