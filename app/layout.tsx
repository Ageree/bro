import type { Metadata, Viewport } from "next";
import { Geist, Source_Serif_4 } from "next/font/google";
import { headers } from "next/headers";
import { travelpayoutsDriveHeader } from "@web/auth/travelpayouts";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { applicationOrigin } from "@shared/environment/origin";
import { requestSession } from "@web/auth/request-scope";
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

// Travelpayouts Drive confirms the site by reading this snippet from the raw
// HTML of its page. The tag sits in the document head so the check sees it
// in the HTML the server sends, and only on the public pages
// (`web/auth/travelpayouts.ts`). `nowprocket` is an empty string so React
// emits the attribute.
const travelpayoutsDrive = `
  (function () {
      var script = document.createElement("script");
      script.async = 1;
      script.setAttribute("data-cmp-ab","2");
      script.src = 'https://emrldtp.cc/NTkwNzk5.js?t=590799';
      document.head.appendChild(script);
  })();
`;

const travelpayoutsDriveAttributes = {
  nowprocket: "",
  "data-noptimize": "1",
  "data-cfasync": "false",
  "data-wpfc-render": "false",
  "seraph-accel-crit": "1",
  "data-no-defer": "1",
  "data-cmp-ab": "2",
};

export const metadata: Metadata = {
  metadataBase: new URL(applicationOrigin()),
  title: {
    default: "bro — твой последний ИИ-агент",
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
  const session = await requestSession();
  const workspaceId = session
    ? accessScopeForUser(`better-auth:${session.user.id}`).workspaceId
    : undefined;
  const drive = (await headers()).get(travelpayoutsDriveHeader) === "1";

  return (
    <html className={`${serif.variable} ${geist.variable}`} lang="ru">
      {drive && (
        <head>
          <script {...travelpayoutsDriveAttributes}>
            {travelpayoutsDrive}
          </script>
        </head>
      )}
      <body data-brand="bro" data-workspace-id={workspaceId}>
        {children}
      </body>
    </html>
  );
}
