import { QueryProvider } from "@app/_providers/query-provider";
import { voiceTalkEnabled } from "@shared/voice/pilot";
import { isAdminScope } from "@web/auth/admin";
import { requestSession, requireRequestScope } from "@web/auth/request-scope";
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
  const scope = requireRequestScope();
  const [showAdmin, session, { workspaceId }] = await Promise.all([
    scope.then(isAdminScope),
    requestSession(),
    scope,
  ]);

  return (
    <QueryProvider>
      <TRPCProvider>
        <TooltipProvider>
          <CabinetFrame
            account={
              <AuthenticatedAccountControl
                phoneNumber={session?.user.phoneNumber}
              />
            }
            showAdmin={showAdmin}
            showVoice={voiceTalkEnabled(workspaceId)}
          >
            {children}
          </CabinetFrame>
        </TooltipProvider>
      </TRPCProvider>
    </QueryProvider>
  );
}
