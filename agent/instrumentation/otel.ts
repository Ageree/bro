import { otel } from "eve/instrumentation/otel";

/**
 * Process-wide OpenTelemetry settings. Traces operations without copying user
 * messages, remembered facts, tool payloads, or model responses into spans.
 */
export default otel({
  traceChannelRequests: true,
  tracePolicy: () => ({
    emit: true,
    recordInputs: false,
    recordOutputs: false,
  }),
});
