"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  SidebarGroup,
  SidebarGroupContent,
  useSidebar,
} from "@web/components/ui/sidebar";

const navigation = [
  { href: "/workspace", id: "workspace", label: "Кабинет" },
  { href: "/vault", id: "vault", label: "Сейф" },
  { href: "/personal-info", id: "personal-info", label: "Личные данные" },
  { href: "/chat", id: "chat", label: "Чат" },
  { href: "/chat/history", id: "history", label: "Все чаты" },
] as const;

/**
 * The rail is the masthead stood on its side: a column of text under the
 * wordmark. No icons, no pills, no filled row — the page you are on is ink,
 * the rest is grey, and a hovered row fades like every other link here.
 */
export function AuthenticatedNavigation() {
  const active = activeRoute(usePathname());

  return (
    <SidebarGroup className="px-bro-rail py-0">
      <SidebarGroupContent>
        <nav aria-label="Основная навигация">
          <ul className="flex list-none flex-col gap-[0.35rem] bro-rail">
            {navigation.map((item) => (
              <li key={item.id}>
                <Link
                  aria-current={active === item.id ? "page" : undefined}
                  className="type-act block bro-link"
                  href={item.href}
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

/**
 * On a narrow screen the rail is off canvas, so the page carries one line of
 * chrome: the way to the rail, and the page you are on. Both are text —
 * there is no hamburger on this site.
 */
export function AuthenticatedMobileHeader() {
  const { toggleSidebar } = useSidebar();
  const active = activeRoute(usePathname());
  const label = navigation.find((item) => item.id === active)?.label;

  return (
    <header className="flex items-baseline justify-between gap-4 border-b border-border px-bro-pad py-[0.85rem] md:hidden">
      <button
        aria-label="Открыть меню"
        className="type-act bro-link"
        onClick={toggleSidebar}
        type="button"
      >
        Меню
      </button>
      <span className="type-status text-muted-foreground">{label}</span>
    </header>
  );
}

function activeRoute(pathname: string) {
  if (pathname.startsWith("/workspace")) return "workspace";
  if (pathname.startsWith("/vault")) return "vault";
  if (pathname.startsWith("/personal-info")) return "personal-info";
  if (pathname.startsWith("/chat/history")) return "history";
  if (pathname.startsWith("/chat")) return "chat";
  return undefined;
}
