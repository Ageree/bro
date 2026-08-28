import {
  claimNumberOptions,
  dedicatedClaimIdempotencyKey,
  dedicatedLineEnabled,
  dedicatedLineFromIdentityPayload,
  dedicatedLineFromInventory,
  dedicatedLineFromInventoryNumber,
  existingIdentityUpdateOptions,
  identityCreateBody,
  sdkCreateIdentityOptions,
} from "../convex/lib/dedicatedLinePolicy.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

assert(!dedicatedLineEnabled(undefined), "default off");
assert(!dedicatedLineEnabled(""), "empty off");
assert(!dedicatedLineEnabled("0"), "0 off");
assert(!dedicatedLineEnabled("false"), "false off");
assert(!dedicatedLineEnabled("no"), "no off");
assert(!dedicatedLineEnabled("off"), "off off");
assert(!dedicatedLineEnabled("shared"), "shared off");
assert(dedicatedLineEnabled("1"), "1 on");
assert(dedicatedLineEnabled("true"), "true on");
assert(dedicatedLineEnabled("TRUE"), "TRUE on");
assert(dedicatedLineEnabled(" yes "), "yes on");
assert(dedicatedLineEnabled("on"), "on on");

const sharedRest = identityCreateBody({
  handle: "bro-a1b2c3d4",
  displayName: "Bro",
  dedicatedLine: false,
});
assert(sharedRest.imessage_enabled === true, "rest always imessage");
assert(sharedRest.agent_handle === "bro-a1b2c3d4", "rest handle");
assert(
  !("claim_imessage_number" in sharedRest),
  "shared rest omits claim_imessage_number",
);

const dedicatedRest = identityCreateBody({
  handle: "bro-a1b2c3d4",
  displayName: "Bro",
  dedicatedLine: true,
});
assert(dedicatedRest.claim_imessage_number === true, "rest claims");
assert(dedicatedRest.imessage_enabled === true, "claim requires imessage");

const sharedSdk = sdkCreateIdentityOptions(false);
assert(sharedSdk.imessageEnabled === true, "sdk always imessage");
assert(
  !("claimIMessageNumber" in sharedSdk),
  "shared sdk omits claimIMessageNumber",
);

const dedicatedSdk = sdkCreateIdentityOptions(true);
assert(dedicatedSdk.claimIMessageNumber === true, "sdk claims");
assert(dedicatedSdk.imessageEnabled === true, "sdk claim requires imessage");

assert(
  existingIdentityUpdateOptions({
    dedicatedLine: false,
    imessageEnabled: true,
    hasDedicatedNumber: false,
    handle: "bro-a1b2c3d4",
  }) === undefined,
  "existing shared no-op",
);

const enableOnly = existingIdentityUpdateOptions({
  dedicatedLine: false,
  imessageEnabled: false,
  hasDedicatedNumber: false,
  handle: "bro-a1b2c3d4",
});
assert(enableOnly?.imessageEnabled === true, "existing enable imessage");
assert(
  enableOnly?.claimIMessageNumber === undefined,
  "existing shared does not claim",
);

const claimExisting = existingIdentityUpdateOptions({
  dedicatedLine: true,
  imessageEnabled: true,
  hasDedicatedNumber: false,
  handle: "bro-a1b2c3d4",
});
assert(claimExisting?.claimIMessageNumber === true, "existing claims");
assert(
  claimExisting?.idempotencyKey === dedicatedClaimIdempotencyKey("bro-a1b2c3d4"),
  "existing idempotency",
);

const alreadyAttached = existingIdentityUpdateOptions({
  dedicatedLine: true,
  imessageEnabled: true,
  hasDedicatedNumber: true,
  handle: "bro-a1b2c3d4",
});
assert(alreadyAttached === undefined, "already attached no-op");

const claimOpts = claimNumberOptions("bro-dedicated-bro-a1b2c3d4");
assert(claimOpts.idempotencyKey === "bro-dedicated-bro-a1b2c3d4", "claimNumber key");
assert(
  Object.keys(claimOpts).length === 1,
  "claimNumber only takes idempotencyKey",
);

const identityLine = dedicatedLineFromIdentityPayload({
  imessageNumber: { id: "n1", number: "+15551212", type: "dedicated_outbound" },
});
assert(identityLine?.number === "+15551212", "IdentityIMessageNumber number");
assert(identityLine?.id === "n1", "IdentityIMessageNumber id");
assert(identityLine?.status === undefined, "IdentityIMessageNumber has no status");
assert(
  dedicatedLineFromIdentityPayload({
    imessage_number: { id: "n1", number: "+15551212", type: "dedicated_outbound" },
  })?.number === "+15551212",
  "rest snake_case number",
);
assert(
  dedicatedLineFromIdentityPayload({
    imessageNumber: {
      id: "n1",
      number: "+15551212",
      type: "dedicated_outbound",
      status: "active",
    },
  })?.status === undefined,
  "identity embed status is dropped",
);
assert(
  dedicatedLineFromIdentityPayload({ imessage_number: null }) === undefined,
  "null line",
);

const fromListNumbers = dedicatedLineFromInventoryNumber({
  id: "n1",
  number: "+15551212",
  type: "dedicated_outbound",
  status: "active",
  agentIdentityId: "id1",
  agentHandle: "bro-a1b2c3d4",
});
assert(fromListNumbers?.status === "active", "IMessageNumber.status from listNumbers");
assert(
  dedicatedLineFromInventoryNumber({
    id: "n1",
    number: "+15559999",
    type: "dedicated_outbound",
    status: "paused",
    agent_identity_id: null,
    agent_handle: null,
  })?.status === "paused",
  "RawIMessageNumber.status from REST inventory",
);
assert(
  dedicatedLineFromInventoryNumber({ number: "" }) === undefined,
  "empty number ignored",
);

const merged = dedicatedLineFromInventory(identityLine, [
  {
    id: "n1",
    number: "+15551212",
    type: "dedicated_outbound",
    status: "active",
    agentIdentityId: "id1",
    agentHandle: "bro-a1b2c3d4",
  },
], { identityId: "id1", handle: "bro-a1b2c3d4" });
assert(merged?.number === "+15551212", "merged number");
assert(merged?.status === "active", "status comes from listNumbers");

const restMerged = dedicatedLineFromInventory(identityLine, [
  {
    id: "n1",
    number: "+15551212",
    type: "dedicated_outbound",
    status: "paused",
    agent_identity_id: "id1",
    agent_handle: "bro-a1b2c3d4",
  },
], { identityId: "id1", handle: "bro-a1b2c3d4" });
assert(restMerged?.status === "paused", "status from REST /imessage/numbers");

assert(
  dedicatedLineFromInventory(identityLine, [], { identityId: "id1" })?.status ===
    undefined,
  "no inventory keeps number without status",
);

console.log("dedicated-line-check ok");
