import type { Metadata, Viewport } from "next";
import { Onest, Prata } from "next/font/google";
import { headers } from "next/headers";
import { QueryProvider } from "@app/_providers/query-provider";
import { TooltipProvider } from "@web/components/ui/tooltip";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { applicationOrigin } from "@shared/environment/origin";
import { getAuthSession } from "@db/services/auth/session";
import "./globals.css";

// The display face carries the whole brand; the gothic is only for fine
// print. Prata ships a single weight, Onest is a variable font, so the
// shared type recipes keep their weights. Both are self-hosted by next/font
// and reach the stylesheet as `--font-prata` and `--font-onest`.
const prata = Prata({
  display: "swap",
  subsets: ["cyrillic", "latin"],
  variable: "--font-prata",
  weight: "400",
});

const onest = Onest({
  display: "swap",
  subsets: ["cyrillic", "latin"],
  variable: "--font-onest",
});

export const metadata: Metadata = {
  metadataBase: new URL(applicationOrigin()),
  title: {
    default: "bro — твой личный ИИ-агент",
    template: "bro — %s",
  },
  description:
    "bro — персональный ИИ-агент со своим номером, памятью и руками в интернете. Записать к врачу, забронировать, заказать — просто напиши ему.",
};

export const viewport: Viewport = {
  initialScale: 1,
  themeColor: "#ffffff",
  viewportFit: "cover",
  width: "device-width",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const session = await getAuthSession(await headers());
  const workspaceId = session
    ? accessScopeForUser(`better-auth:${session.user.id}`).workspaceId
    : undefined;

  return (
    <html className={`${prata.variable} ${onest.variable}`} lang="ru">
      <body data-brand="bro" data-workspace-id={workspaceId}>
        <QueryProvider>
          <TooltipProvider>{children}</TooltipProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
