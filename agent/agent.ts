import { defineAgent, defineDynamic } from "eve";
import { DEFAULT_ROOT_CONTEXT_TOKENS } from "./lib/model";
import { resolveBroModelForTurn } from "./lib/resolve-bro-model";

export default defineAgent({
  model: defineDynamic({
    events: {
      "step.started": (_event, ctx) =>
        resolveBroModelForTurn(ctx, {
          contextTokens: DEFAULT_ROOT_CONTEXT_TOKENS,
        }),
    },
  }),
  compaction: {
    thresholdPercent: 0.7,
  },
  // Spectrum still boots createGrpcClient, which import.meta.resolve()s these
  // peers from /var/task/index.mjs. Inlining them into the bundle leaves no
  // package on disk, so every outbound Photon send throws MODULE_NOT_FOUND.
  build: {
    externalDependencies: [
      "@grpc/grpc-js",
      "nice-grpc",
      "nice-grpc-common",
    ],
  },
});
