const messages = {
  NOT_CONFIGURED: "Phone provisioning is not configured.",
  INVALID_INPUT: "The phone provisioning request is invalid.",
  CANDIDATE_UNAVAILABLE:
    "The exact quoted phone number is no longer available.",
  FEE_CAP_CHANGED:
    "Current provider fees exceed the approved provisioning terms.",
  INSUFFICIENT_FUNDS: "Phone provisioning requires operator action.",
  PROVIDER_READ_FAILED: "Phone provisioning preflight could not be completed.",
  RESOURCE_BINDING_INVALID:
    "The requested phone resource binding could not be verified.",
  QUOTA_EXCEEDED: "Phone provisioning capacity is unavailable.",
  AGENT_NOT_READY: "The configured Bro phone agent is not ready.",
} as const;

export type PhonePreflightCode = keyof typeof messages;

export class PhonePreflightError extends Error {
  readonly kind = "phone_preflight" as const;
  readonly code: PhonePreflightCode;

  constructor(code: PhonePreflightCode) {
    super(messages[code]);
    this.name = "PhonePreflightError";
    this.code = code;
  }
}
