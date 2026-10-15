"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Capsule, type CapsuleItem } from "@web/components/paper/capsule";
import { SiteFooter } from "@web/components/paper/footer";

const navigation: readonly CapsuleItem[] = [
  { href: "/workspace", id: "workspace", label: "Кабинет" },
  { href: "/chat", id: "chat", label: "Чат" },
  { href: "/chat/history", id: "history", label: "Все чаты" },
  { href: "/personal-info", id: "personal-info", label: "Личные данные" },
];

const adminItem: CapsuleItem = {
  href: "/workspace/admin",
  id: "admin",
  label: "Владелец",
};

/**
 * The frame of the cabinet: the capsule on top and the page under it. A
 * document page scrolls with the footer at its foot; the chat owns the whole
 * screen below the capsule, so it has no footer and nothing scrolls but the
 * conversation. The vault lives inside the cabinet, so it has no item here.
 */
export function CabinetFrame({
  account,
  children,
  showAdmin = false,
}: {
  readonly account: ReactNode;
  readonly children: ReactNode;
  readonly showAdmin?: boolean;
}) {
  const pathname = usePathname();
  const active = activeRoute(pathname);
  const items = showAdmin ? [...navigation, adminItem] : navigation;
  const ownsScreen = active === "chat";

  if (ownsScreen) {
    return (
      <div className="flex h-svh flex-col overflow-hidden">
        <Capsule active={active} items={items} wordmarkHref="/workspace" />
        <div className="relative min-h-0 flex-1 pt-[5rem]">{children}</div>
      </div>
    );
  }

  return (
    <div className="flex min-h-svh flex-col">
      <Capsule active={active} items={items} wordmarkHref="/workspace" />
      <div className="flex-1 pt-[5.5rem]">{children}</div>
      <SiteFooter>{account}</SiteFooter>
    </div>
  );
}

function activeRoute(pathname: string) {
  if (pathname.startsWith("/workspace/admin")) return "admin";
  if (pathname.startsWith("/workspace")) return "workspace";
  if (pathname.startsWith("/personal-info")) return "personal-info";
  if (pathname.startsWith("/chat/history")) return "history";
  if (pathname.startsWith("/chat")) return "chat";
  return undefined;
}
