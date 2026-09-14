import {
  INBOUND_AT_ATTR,
  inboundAt,
  inboundAtAttribute,
  latencyFields,
  sinceInbound,
} from "../agent/lib/latency-log.ts";

import { assert, src } from "./lib/check.ts";

const stamped = inboundAtAttribute(1_000);
assert(stamped[INBOUND_AT_ATTR] === "1000", "stamp is a string (wire v1 attributes)");
assert(inboundAt(stamped) === 1_000, "stamp round-trips");
assert(inboundAt({ inboundAt: ["1000"] }) === 1_000, "array-valued attribute reads first item");
assert(inboundAt({ inboundAt: "nope" }) === undefined, "garbage is ignored");
assert(inboundAt(undefined) === undefined, "missing attrs are fine");
assert(sinceInbound(stamped, 1_450) === 450, "elapsed ms");
assert(sinceInbound(stamped, 900) === 0, "clock skew never goes negative");
assert(latencyFields(stamped, 1_450).sinceInboundMs === 450, "log field");
assert(!("sinceInboundMs" in latencyFields({})), "no stamp → no field");

for (const file of ["agent/channels/imessage.ts", "agent/channels/telegram.ts"]) {
  const text = src(file);
  assert(text.includes("inboundAtAttribute("), `${file} stamps receipt time on the turn`);
  assert(text.includes("queuedAfterMs"), `${file} logs webhook → queue time`);
}
const events = src("agent/lib/turn-delivery-events.ts");
assert(events.includes("turn first bubble delivered"), "first bubble delivery is logged");
assert((events.match(/latencyFields\(/g) ?? []).length >= 4, "every delivery log carries sinceInboundMs");
assert(src("agent/instructions/jobs.ts").includes('console.log("turn started"'), "turn.started is logged with elapsed ms");

console.log("latency-log-check ok");
