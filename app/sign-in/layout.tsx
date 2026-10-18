import { QueryProvider } from "@app/_providers/query-provider";

/**
 * The sign-in forms send their codes through react-query. The provider sits
 * here rather than in the root layout, so the landing ships none of it.
 */
export default function SignInLayout({ children }: LayoutProps<"/sign-in">) {
  return <QueryProvider>{children}</QueryProvider>;
}
