import { QueryProvider } from "@app/_providers/query-provider";
import { isAdminScope } from "@web/auth/admin";
import { requireRequestScope } from "@web/auth/request-scope";
import { TooltipProvider } from "@web/components/ui/tooltip";
import { TRPCProvider } from "@web/trpc/client";
import { AuthenticatedAccountControl } from "./_components/account-control";
import { CabinetFrame } from "./_components/authenticated-navigation";

/**
 * The cabinet is the landing's plates on warm paper: a capsule on top, one
 * page under it, the ink footer at its foot. The query and tooltip providers
 * live here, not in the root layout: the landing needs neither.
 */
export default async function AuthenticatedLayout({
  children,
}: LayoutProps<"/">) {
  const showAdmin = await isAdminScope(await requireRequestScope());

  return (
    <QueryProvider>
      <TRPCProvider>
        <TooltipProvider>
          <CabinetFrame
            account={<AuthenticatedAccountControl />}
            showAdmin={showAdmin}
          >
            {children}
          </CabinetFrame>
        </TooltipProvider>
      </TRPCProvider>
    </QueryProvider>
  );
}
