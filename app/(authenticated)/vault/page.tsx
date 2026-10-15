import { redirect } from "next/navigation";

/**
 * The vault lives in the cabinet now. Links the agent and the chat history
 * already hold keep working, with their query: `?setup=vault&kind=payment`
 * still opens the right sheet.
 */
export default async function Page({ searchParams }: PageProps<"/vault">) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const item of [value ?? []].flat()) query.append(key, item);
  }
  const search = query.toString();
  redirect(search ? `/workspace?${search}` : "/workspace");
}
