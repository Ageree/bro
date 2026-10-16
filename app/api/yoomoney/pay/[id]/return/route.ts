import { NextResponse } from "next/server";
import { readBackYoomoneyCardPayment } from "@db/services/yoomoney/card";
import { applicationOrigin } from "@shared/environment/origin";

/** What the bank said, by the address YooMoney sent the person back to. */
const verdicts = new Map<string, "passed" | "failed">([
  ["ok", "passed"],
  ["fail", "failed"],
]);

/**
 * Where the person's bank sends them back after 3-D Secure (`r`: passed
 * or not), and the page's own checks: the payment is read back, then shown
 * on its page.
 */
export async function GET(
  request: Request,
  { params }: RouteContext<"/api/yoomoney/pay/[id]/return">
) {
  const { id } = await params;
  const query = new URL(request.url).searchParams;
  const token = query.get("t") ?? "";
  try {
    await readBackYoomoneyCardPayment(
      id,
      token,
      verdicts.get(query.get("r") ?? "")
    );
  } catch (error) {
    console.warn("[yoomoney] card payment read back failed", {
      name: error instanceof Error ? error.name : "unknown",
    });
  }
  const page = new URL(`/pay/${id}`, applicationOrigin());
  page.searchParams.set("t", token);
  return NextResponse.redirect(page, {
    headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}
