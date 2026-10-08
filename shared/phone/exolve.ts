import { z } from "zod";
import { env } from "@shared/environment";
import {
  PhonePreflightError,
  type PhonePreflightCode,
} from "@shared/phone/errors";

const digits = z.string().regex(/^7\d{10}$/u);
const phone = z.string().regex(/^\+7\d{10}$/u);
const identifier = z
  .union([
    z.string().regex(/^\d+$/u),
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ])
  .transform(String);
const fee = z.number().nonnegative();
const offer = z.object({
  number_code: digits,
  install_fee: fee,
  subscription_fee: fee,
  number_options: z.object({
    incoming_calls: z.boolean(),
    outgoing_calls: z.boolean(),
  }),
});
const offers = z.object({ numbers: z.array(offer).default([]) });
const fees = z.object({ install_fee: fee, subscription_fee: fee });
const owned = z.object({
  numbers: z.array(z.object({ number_name: digits })).default([]),
  total: z.number().int().nonnegative(),
});
const sips = z.object({
  sips: z
    .array(z.object({ sip_resource_id: identifier, cli: digits }))
    .default([]),
});
const attributes = z.object({
  attributes: z.object({
    call_forwarding_type: z.number().int().optional(),
    call_forwarding_sip: z.object({ sip_uri: z.string() }).optional(),
  }),
});
const empty = z.object({}).strict();
const purchase = z.object({
  candidate: phone,
  maxSetupRub: fee,
  maxMonthlyRub: fee,
  maxSipMonthlyRub: fee,
});
const forwarding = z.object({ numberId: digits, number: phone });
const disconnect = z.object({ numberId: digits, sipId: identifier.nullable() });

async function request<T extends z.ZodType>(
  path: string,
  body: Record<string, z.core.util.JSONType | undefined>,
  schema: T,
  mutation = false
): Promise<z.output<T>> {
  const key = env.MTS_EXOLVE_API_KEY;
  if (!key) throw new Error("Exolve is not configured.");
  try {
    const response = await fetch(`https://api.exolve.ru${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Request rejected.");
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) throw new Error("Invalid response.");
    return parsed.data;
  } catch {
    throw new Error(
      mutation
        ? "Exolve mutation could not be verified; reconcile before any retry."
        : "Exolve read failed; no authoritative result available."
    );
  }
}

function valid<T extends z.ZodType>(schema: T, value: z.input<T>): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid Exolve input.");
  return parsed.data;
}

async function available(candidate?: string) {
  const body = {
    type_id: 1104,
    region_id: 10230,
    category_id: 10000,
    limit: 10,
    offset: 0,
    mask: candidate,
  };
  return request("/number/v1/GetFree", body, offers);
}

async function sipInventory(
  offset = 0
): Promise<z.output<typeof sips>["sips"]> {
  if (offset >= 10_000)
    throw new Error("Exolve SIP inventory exceeds reconciliation limit.");
  const page = await request(
    "/number/customer/v1/GetSIPList",
    { limit: 100, offset },
    sips
  );
  if (page.sips.length < 100) return page.sips;
  return page.sips.concat(await sipInventory(offset + 100));
}

export async function quoteNumber() {
  try {
    if (!env.MTS_EXOLVE_API_KEY)
      throw new PhonePreflightError("NOT_CONFIGURED");
    const [inventory, sipFee] = await Promise.all([
      available(),
      request("/sip/v1/GetFees", {}, fees),
    ]);
    if (sipFee.install_fee !== 0)
      throw new PhonePreflightError("FEE_CAP_CHANGED");
    const candidate = inventory.numbers
      .filter(
        (entry) =>
          entry.number_options.incoming_calls &&
          entry.number_options.outgoing_calls
      )
      .toSorted(
        (a, b) =>
          a.subscription_fee - b.subscription_fee ||
          a.install_fee - b.install_fee
      )[0];
    if (!candidate) throw new PhonePreflightError("CANDIDATE_UNAVAILABLE");
    return {
      candidate: `+${candidate.number_code}`,
      setupRub: candidate.install_fee + sipFee.install_fee,
      monthlyRub: candidate.subscription_fee,
      sipMonthlyRub: sipFee.subscription_fee,
      quotedAt: new Date(),
    };
  } catch (error) {
    if (error instanceof PhonePreflightError) throw error;
    throw new PhonePreflightError("PROVIDER_READ_FAILED");
  }
}

export async function findOwnedNumber(candidate: string) {
  const number = valid(phone, candidate);
  const matches: z.output<typeof owned>["numbers"] = [];
  const seen = new Set<string>();
  async function readPage(
    offset: number
  ): Promise<z.output<typeof owned>["numbers"]> {
    if (offset >= 10_000)
      throw new Error("Exolve number inventory exceeds reconciliation limit.");
    const page = await request(
      "/number/customer/v1/GetList",
      { limit: 100, offset },
      owned
    );
    for (const entry of page.numbers) {
      if (seen.has(entry.number_name))
        throw new Error("Exolve number inventory is ambiguous.");
      seen.add(entry.number_name);
      if (`+${entry.number_name}` === number) matches.push(entry);
    }
    if (offset + page.numbers.length >= page.total) {
      if (matches.length > 1)
        throw new Error("Exolve number ownership is ambiguous.");
      return matches;
    }
    if (page.numbers.length !== 100)
      throw new Error("Exolve number inventory is incomplete.");
    return readPage(offset + 100);
  }
  const match = (await readPage(0))[0];
  return match
    ? { numberId: match.number_name, number: `+${match.number_name}` }
    : null;
}

export async function purchaseNumber(input: z.input<typeof purchase>) {
  let mutationAttempted = false;
  let existingResource = false;
  let failureCode: PhonePreflightCode = "INVALID_INPUT";
  try {
    const value = valid(purchase, input);
    if (!env.MTS_EXOLVE_API_KEY)
      throw new PhonePreflightError("NOT_CONFIGURED");
    failureCode = "PROVIDER_READ_FAILED";
    const existing = await findOwnedNumber(value.candidate);
    if (existing) {
      existingResource = true;
      return existing;
    }
    const code = value.candidate.slice(1);
    const [inventory, sipFee] = await Promise.all([
      available(code),
      request("/sip/v1/GetFees", {}, fees),
    ]);
    const matches = inventory.numbers.filter(
      (entry) => entry.number_code === code
    );
    const candidate = matches[0];
    if (matches.length !== 1 || !candidate)
      throw new PhonePreflightError("CANDIDATE_UNAVAILABLE");
    if (
      !candidate.number_options.incoming_calls ||
      !candidate.number_options.outgoing_calls
    )
      throw new PhonePreflightError("CANDIDATE_UNAVAILABLE");
    if (sipFee.install_fee !== 0)
      throw new PhonePreflightError("FEE_CAP_CHANGED");
    if (
      candidate.install_fee + sipFee.install_fee > value.maxSetupRub ||
      candidate.subscription_fee > value.maxMonthlyRub ||
      sipFee.subscription_fee > value.maxSipMonthlyRub
    )
      throw new PhonePreflightError("FEE_CAP_CHANGED");
    const balance = await request(
      "/finance/v1/GetBalance",
      {},
      z.object({ balance: z.number() })
    );
    const requiredRub =
      candidate.install_fee +
      candidate.subscription_fee +
      sipFee.install_fee +
      sipFee.subscription_fee;
    if (balance.balance < requiredRub)
      throw new PhonePreflightError("INSUFFICIENT_FUNDS");
    mutationAttempted = true;
    const reservation = await request(
      "/number/v1/Lock",
      {
        number_code: code,
        seconds: 300,
        description: "Bro dedicated voice number",
      },
      z
        .object({
          Id: z
            .union([
              z.string().regex(/^\d+$/u),
              z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
            ])
            .optional(),
          id: z
            .union([
              z.string().regex(/^\d+$/u),
              z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
            ])
            .optional(),
        })
        .refine((entry) => entry.Id !== undefined || entry.id !== undefined),
      true
    );
    await request(
      "/number/v1/Buy",
      { number_code: code, reserve_uid: reservation.Id ?? reservation.id },
      empty,
      true
    );
    const purchased = await findOwnedNumber(value.candidate);
    if (!purchased)
      throw new Error(
        "Exolve purchase is not yet verified; reconcile before any retry."
      );
    return purchased;
  } catch (error) {
    if (!mutationAttempted && !existingResource) {
      if (error instanceof PhonePreflightError) throw error;
      throw new PhonePreflightError(failureCode);
    }
  }
  throw new Error(
    "Exolve number provisioning is unverified; preserve existing resources and reconcile before any retry."
  );
}

export async function findSip(numberId: string) {
  const code = valid(digits, numberId);
  const matches = (await sipInventory()).filter((entry) => entry.cli === code);
  if (matches.length > 1)
    throw new Error("Exolve SIP association is ambiguous.");
  const match = matches[0];
  if (match) {
    const detail = await request(
      "/sip/v1/GetAttributes",
      { sip_resource_id: match.sip_resource_id },
      z.object({
        sip_resource_id: identifier,
        attributes: z.object({ cli: digits }),
        numbers_with_call_forwarding: z.array(identifier).default([]),
      })
    );
    if (
      detail.sip_resource_id !== match.sip_resource_id ||
      detail.attributes.cli !== code ||
      detail.numbers_with_call_forwarding.some((number) => number !== code)
    )
      throw new Error(
        "Exolve SIP is shared or its number binding is inconsistent."
      );
  }
  return match ? { sipId: match.sip_resource_id } : null;
}

const sipCreation = z.object({ numberId: digits, maxMonthlyRub: fee });

export async function createSip(input: z.input<typeof sipCreation>) {
  let mutationAttempted = false;
  let existingResource = false;
  let failureCode: PhonePreflightCode = "INVALID_INPUT";
  try {
    const value = valid(sipCreation, input);
    if (!env.MTS_EXOLVE_API_KEY)
      throw new PhonePreflightError("NOT_CONFIGURED");
    failureCode = "PROVIDER_READ_FAILED";
    const code = value.numberId;
    if (!(await findOwnedNumber(`+${code}`)))
      throw new PhonePreflightError("RESOURCE_BINDING_INVALID");
    existingResource = (await sipInventory()).some(
      (entry) => entry.cli === code
    );
    const existing = await findSip(code);
    if (existing) {
      existingResource = true;
      const current = await request(
        "/sip/v1/GetAttributes",
        { sip_resource_id: existing.sipId },
        z.object({
          attributes: z.object({ subscription_fee: fee, install_fee: fee }),
        })
      );
      if (
        current.attributes.subscription_fee > value.maxMonthlyRub ||
        current.attributes.install_fee !== 0
      )
        throw new Error(
          "Existing Exolve SIP fees exceed the approved provisioning contract."
        );
      return existing;
    }
    const freshFee = await request("/sip/v1/GetFees", {}, fees);
    if (
      freshFee.install_fee !== 0 ||
      freshFee.subscription_fee > value.maxMonthlyRub
    )
      throw new PhonePreflightError("FEE_CAP_CHANGED");
    mutationAttempted = true;
    const receipt = await request(
      "/sip/v1/Create",
      {
        sip_name: `Bro-${code}`,
        number: code,
        description: "Bro dedicated voice number",
        call_record: false,
      },
      z.object({ sip_resource_id: identifier }),
      true
    );
    const created = await findSip(code);
    if (created?.sipId !== receipt.sip_resource_id)
      throw new Error(
        "Exolve SIP creation is not verified; reconcile before any retry."
      );
    const charged = await request(
      "/sip/v1/GetAttributes",
      { sip_resource_id: created.sipId },
      z.object({
        attributes: z.object({ subscription_fee: fee, install_fee: fee }),
      })
    );
    if (
      charged.attributes.subscription_fee > value.maxMonthlyRub ||
      charged.attributes.install_fee !== 0
    )
      throw new Error(
        "Created Exolve SIP has unapproved fees; operator reconciliation is required."
      );
    return created;
  } catch (error) {
    if (!mutationAttempted && !existingResource) {
      if (error instanceof PhonePreflightError) throw error;
      throw new PhonePreflightError(failureCode);
    }
  }
  throw new Error(
    "Exolve SIP provisioning is unverified; preserve existing resources and reconcile before any retry."
  );
}

export async function readSipCredentials(sipId: string) {
  const value = await request(
    "/sip/v1/GetAttributes",
    { sip_resource_id: valid(identifier, sipId) },
    z.object({
      attributes: z.object({
        login: z.string().min(1),
        password: z.string().min(1),
        domain: z.literal("sip.exolve.ru"),
        cli: digits,
      }),
    })
  );
  return {
    username: value.attributes.login,
    password: value.attributes.password,
    hostname: value.attributes.domain,
    publicNumber: `+${value.attributes.cli}`,
  };
}

export async function configureForwarding(input: z.input<typeof forwarding>) {
  const value = valid(forwarding, input);
  if (
    `+${value.numberId}` !== value.number ||
    !(await findOwnedNumber(value.number))
  )
    throw new Error("Exolve forwarding number binding is invalid.");
  const uri = `${value.number}@sip.rtc.elevenlabs.io:5060;transport=tcp`;
  const current = await request(
    "/number/v1/GetAttributes",
    { number_code: value.numberId },
    attributes
  );
  if (
    current.attributes.call_forwarding_type === 1 &&
    current.attributes.call_forwarding_sip?.sip_uri === uri
  )
    return;
  await request(
    "/number/v1/SetCallForwarding",
    {
      number_code: value.numberId,
      call_forwarding_type: 1,
      call_forwarding_sip: { sip_uri: uri },
    },
    empty,
    true
  );
  const configured = await request(
    "/number/v1/GetAttributes",
    { number_code: value.numberId },
    attributes
  );
  if (
    configured.attributes.call_forwarding_type !== 1 ||
    configured.attributes.call_forwarding_sip?.sip_uri !== uri
  )
    throw new Error("Exolve forwarding could not be verified.");
}

const numberBinding = forwarding.extend({ sipId: z.string().regex(/^\d+$/u) });

export async function verifyNumberBinding(
  input: z.input<typeof numberBinding>
) {
  const value = valid(numberBinding, input);
  if (
    `+${value.numberId}` !== value.number ||
    !(await findOwnedNumber(value.number))
  )
    throw new Error("Exolve owned number binding is not verified.");
  if ((await findSip(value.numberId))?.sipId !== value.sipId)
    throw new Error("Exolve dedicated SIP binding is not verified.");
  const [routing, numberFee, sipFee] = await Promise.all([
    request(
      "/number/v1/GetAttributes",
      { number_code: value.numberId },
      attributes
    ),
    request(
      "/number/customer/v1/GetInfo",
      { number_code: value.numberId },
      z.object({
        number: z.object({ number_name: digits, subscription_fee: fee }),
      })
    ),
    request(
      "/sip/v1/GetAttributes",
      { sip_resource_id: value.sipId },
      z.object({
        sip_resource_id: identifier,
        attributes: z.object({ cli: digits, subscription_fee: fee }),
      })
    ),
  ]);
  if (
    routing.attributes.call_forwarding_type !== 1 ||
    routing.attributes.call_forwarding_sip?.sip_uri !==
      `${value.number}@sip.rtc.elevenlabs.io:5060;transport=tcp` ||
    numberFee.number.number_name !== value.numberId ||
    sipFee.sip_resource_id !== value.sipId ||
    sipFee.attributes.cli !== value.numberId
  )
    throw new Error("Exolve routing or fee resource binding is not verified.");
  return {
    monthlyRub: numberFee.number.subscription_fee,
    sipMonthlyRub: sipFee.attributes.subscription_fee,
  };
}

export async function disconnectNumber(input: z.input<typeof disconnect>) {
  const value = valid(disconnect, input);
  try {
    const inventory = await sipInventory();
    const associated = inventory.filter(
      (entry) => entry.cli === value.numberId
    );
    if (associated.some((entry) => entry.sip_resource_id !== value.sipId))
      return { released: false };
    if (
      value.sipId &&
      inventory.some(
        (entry) =>
          entry.sip_resource_id === value.sipId && entry.cli !== value.numberId
      )
    )
      return { released: false };
    if (
      associated.length &&
      (await findSip(value.numberId))?.sipId !== value.sipId
    )
      return { released: false };
    const number = await findOwnedNumber(`+${value.numberId}`);
    if (number)
      await request(
        "/number/v1/DeleteCallForwarding",
        { number_code: value.numberId },
        empty,
        true
      );
    if (associated.length) {
      await request(
        "/sip/v1/Delete",
        { sip_resource_id: value.sipId },
        empty,
        true
      );
      if (
        (await sipInventory()).some(
          (entry) => entry.sip_resource_id === value.sipId
        )
      )
        return { released: false };
    }
    if (number)
      await request(
        "/number/v1/Delete",
        { number_code: value.numberId },
        empty,
        true
      );
    return { released: (await findOwnedNumber(`+${value.numberId}`)) === null };
  } catch {
    return { released: false };
  }
}
