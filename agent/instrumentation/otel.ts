import { otel } from "eve/instrumentation/otel";

/**
 * Process-wide OpenTelemetry settings. Keeps the content capture the agent had
 * before eve 0.62 replaced `agent/instrumentation.ts`: model and tool inputs
 * and outputs on every span, plus the inbound channel request span.
 */
export default otel({
  traceChannelRequests: true,
  tracePolicy: () => ({
    emit: true,
    recordInputs: true,
    recordOutputs: true,
  }),
});
