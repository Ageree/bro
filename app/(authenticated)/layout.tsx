import Link from "next/link";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
} from "@web/components/ui/sidebar";
import { requireRequestScope } from "@web/auth/request-scope";
import { TRPCProvider } from "@web/trpc/client";
import { AuthenticatedAccountControl } from "./_components/account-control";
import {
  AuthenticatedMobileHeader,
  AuthenticatedNavigation,
} from "./_components/authenticated-navigation";

/**
 * The cabinet is paper too. The rail carries the same wordmark, on the same
 * white, divided from the page by a hairline and nothing else — the panel,
 * its tint and its filled rows are gone, so the rail reads as the margin of
 * the page rather than a window beside it.
 */
export default async function AuthenticatedLayout({
  children,
}: LayoutProps<"/">) {
  await requireRequestScope();

  return (
    <TRPCProvider>
      <SidebarProvider>
        <Sidebar>
          <SidebarHeader className="p-bro-rail">
            <Link className="type-wordmark bro-link" href="/workspace">
              bro.
            </Link>
          </SidebarHeader>
          <SidebarContent>
            <AuthenticatedNavigation />
          </SidebarContent>
          <SidebarFooter className="p-0">
            <AuthenticatedAccountControl />
          </SidebarFooter>
        </Sidebar>
        <SidebarInset className="h-svh overflow-y-auto">
          <AuthenticatedMobileHeader />
          {children}
        </SidebarInset>
      </SidebarProvider>
    </TRPCProvider>
  );
}
