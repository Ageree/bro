import { isAdminScope } from "@web/auth/admin";
import { requireRequestScope } from "@web/auth/request-scope";
import { TRPCProvider } from "@web/trpc/client";
import { AuthenticatedAccountControl } from "./_components/account-control";
import { CabinetFrame } from "./_components/authenticated-navigation";

/**
 * The cabinet is the landing's plates on warm paper: a capsule on top, one
 * page under it, the ink footer at its foot.
 */
export default async function AuthenticatedLayout({
  children,
}: LayoutProps<"/">) {
  const showAdmin = await isAdminScope(await requireRequestScope());

  return (
    <TRPCProvider>
      <CabinetFrame
        account={<AuthenticatedAccountControl />}
        showAdmin={showAdmin}
      >
        {children}
      </CabinetFrame>
    </TRPCProvider>
  );
}
