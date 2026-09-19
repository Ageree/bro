"use client";

import {
  HistoryIcon,
  KeyRoundIcon,
  MessageSquareIcon,
  PanelsTopLeftIcon,
  UserRoundIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
} from "@web/components/ui/sidebar";

const navigation = [
  {
    href: "/workspace",
    icon: PanelsTopLeftIcon,
    id: "workspace",
    label: "Кабинет",
  },
  { href: "/vault", icon: KeyRoundIcon, id: "vault", label: "Сейф" },
  {
    href: "/personal-info",
    icon: UserRoundIcon,
    id: "personal-info",
    label: "Личные данные",
  },
  { href: "/chat", icon: MessageSquareIcon, id: "chat", label: "Чат" },
  {
    href: "/chat/history",
    icon: HistoryIcon,
    id: "history",
    label: "Все чаты",
  },
] as const;

export function AuthenticatedNavigation() {
  const active = activeRoute(usePathname());

  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <nav aria-label="Основная навигация">
          <SidebarMenu>
            {navigation.map((item) => {
              const Icon = item.icon;
              return (
                <SidebarMenuItem key={item.id}>
                  <SidebarMenuButton
                    isActive={active === item.id}
                    render={<Link href={item.href} />}
                  >
                    <Icon />
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </nav>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

export function AuthenticatedMobileHeader() {
  const active = activeRoute(usePathname());
  const label = navigation.find((item) => item.id === active)?.label;

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/50 px-4 md:hidden">
      <SidebarTrigger />
      <span className="type-label">{label}</span>
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
