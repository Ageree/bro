import { NextResponse } from "next/server";
import { readBackYoomoneyCardPayment } from "@db/services/yoomoney/card";
import { applicationOrigin } from "@shared/environment/origin";

/**
 * Where the person's bank sends them back after 3-D Secure, and the page's
 * «Проверить ещё раз»: the payment is read back, then shown on its page.
 */
export async function GET(
  request: Request,
  { params }: RouteContext<"/api/yoomoney/pay/[id]/return">
) {
  const { id } = await params;
  const token = new URL(request.url).searchParams.get("t") ?? "";
  try {
    await readBackYoomoneyCardPayment(id, token);
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
