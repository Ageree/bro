import type { Metadata, Viewport } from "next";
import { Geist, Source_Serif_4 } from "next/font/google";
import { headers } from "next/headers";
import { QueryProvider } from "@app/_providers/query-provider";
import { TooltipProvider } from "@web/components/ui/tooltip";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { applicationOrigin } from "@shared/environment/origin";
import { getAuthSession } from "@db/services/auth/session";
import "./globals.css";

// Source Serif 4 carries the headings, Geist everything that is read or
// pressed. Both are variable fonts with a Cyrillic subset, self-hosted by
// next/font and reaching the stylesheet as `--font-serif-4` and `--font-geist`.
const serif = Source_Serif_4({
  display: "swap",
  subsets: ["cyrillic", "latin"],
  variable: "--font-serif-4",
  weight: "400",
});

const geist = Geist({
  display: "swap",
  subsets: ["cyrillic", "latin"],
  variable: "--font-geist",
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
  themeColor: "#f1f2ee",
  viewportFit: "cover",
  width: "device-width",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const session = await getAuthSession(await headers());
  const workspaceId = session
    ? accessScopeForUser(`better-auth:${session.user.id}`).workspaceId
    : undefined;

  return (
    <html className={`${serif.variable} ${geist.variable}`} lang="ru">
      <body data-brand="bro" data-workspace-id={workspaceId}>
        <QueryProvider>
          <TooltipProvider>{children}</TooltipProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
