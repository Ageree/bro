import { otelIntegration } from "eve/instrumentation/otel";
import { evlogRuntimeContext } from "evlog/eve";

/**
 * Stamps evlog's turn identity onto the AI SDK telemetry spans, so a trace
 * joins back to the wide event `agent/hooks/evlog.ts` writes. No exporter: the
 * context is contributed to eve's own destinations.
 */
export default otelIntegration({
  runtimeContext: evlogRuntimeContext,
});
