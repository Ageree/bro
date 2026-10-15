import { NextResponse } from "next/server";
import { z } from "zod";
import { payYoomoneyByCard } from "@db/services/yoomoney/card";
import { applicationOrigin } from "@shared/environment/origin";

const formSchema = z.object({
  t: z.string().max(100),
  csc: z.string().max(10).optional(),
});

const escapeHtml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

/**
 * The bank's 3-D Secure page takes the person by a form POST of YooMoney's
 * `acs_params` (YooMoney's docs): a page that submits itself.
 */
function bankForm(acsUri: string, acsParams: Readonly<Record<string, string>>) {
  const fields = Object.entries(acsParams)
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`
    )
    .join("");
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Подтверждение в банке</title></head><body onload="document.forms[0].submit()"><form method="post" action="${escapeHtml(acsUri)}">${fields}<noscript><p>Банк просит подтвердить платёж.</p></noscript><button type="submit">Перейти в банк</button></form></body></html>`;
}

/**
 * «Оплатить» on the card payment's page (`app/(public)/pay/[id]`): only
 * from that page's own origin. The CVV is passed on to YooMoney and
 * dropped; the person lands back on the page, or on their bank's page.
 */
export async function POST(
  request: Request,
  { params }: RouteContext<"/api/yoomoney/pay/[id]">
) {
  const { id } = await params;
  const origin = applicationOrigin();
  if (request.headers.get("origin") !== origin)
    return new NextResponse(null, { status: 403 });
  const form = formSchema.safeParse(
    Object.fromEntries((await request.formData()).entries())
  );
  if (!form.success) return new NextResponse(null, { status: 400 });
  const page = new URL(`/pay/${id}`, origin);
  page.searchParams.set("t", form.data.t);
  let result: Awaited<ReturnType<typeof payYoomoneyByCard>>;
  try {
    result = await payYoomoneyByCard(id, form.data.t, form.data.csc);
  } catch (error) {
    console.warn("[yoomoney] card payment failed", {
      name: error instanceof Error ? error.name : "unknown",
    });
    result = { kind: "settled" };
  }
  if (result.kind === "unavailable")
    return new NextResponse(null, { status: 404 });
  const headers = {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  };
  if (result.kind === "bank") {
    return new NextResponse(bankForm(result.acsUri, result.acsParams), {
      headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
    });
  }
  if (result.kind !== "settled") page.searchParams.set("e", result.kind);
  return NextResponse.redirect(page, { headers, status: 303 });
}
