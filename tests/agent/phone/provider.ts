import { vi } from "vitest";

/** Provider HTTP double: one handler per Exolve path, every call recorded. */
export function exolveFetch(
  handlers: Record<string, () => { status?: number; body: object }>
) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const path = new URL(url).pathname;
      calls.push(path);
      const handler = handlers[path];
      if (!handler) throw new Error(`Unexpected Exolve call: ${path}`);
      const { status = 200, body } = handler();
      return Promise.resolve(Response.json(body, { status }));
    })
  );
  return calls;
}

export function freeNumber(code: string, monthly = 155) {
  return {
    number_code: code,
    install_fee: 600,
    subscription_fee: monthly,
    number_options: { incoming_calls: true, outgoing_calls: true },
  };
}

/** The handlers a purchase needs up to the point where Lock is sent. */
export function preflight(candidate = "74950000001") {
  return {
    "/number/v1/GetFree": () => ({
      body: { numbers: [freeNumber(candidate)] },
    }),
    "/sip/v1/GetFees": () => ({
      body: { install_fee: 0, subscription_fee: 0 },
    }),
    "/finance/v1/GetBalance": () => ({ body: { balance: 100_000 } }),
  };
}

export const ownedList = (codes: string[]) => () => ({
  body: {
    numbers: codes.map((number_name) => ({ number_name })),
    total: codes.length,
  },
});
