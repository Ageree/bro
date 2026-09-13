import { defineAgent } from "eve";
import { DEFAULT_ROOT_CONTEXT_TOKENS, broModel } from "./lib/model";

export default defineAgent({
  ...broModel({ contextTokens: DEFAULT_ROOT_CONTEXT_TOKENS }),
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
