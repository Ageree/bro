import { defineEvalConfig } from "eve/evals";

export default defineEvalConfig({
  // eve 0.62 judges through evaluation models; a language model ID no longer
  // resolves. `typesafe-ai/jev` is the Gateway-native evaluation model.
  judge: { model: "typesafe-ai/jev" },
  maxConcurrency: 4,
  timeoutMs: 180_000,
});
