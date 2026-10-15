import type { Metadata } from "next";
import { Capsule } from "@web/components/paper/capsule";
import { Viewer } from "./viewer";

export const metadata: Metadata = {
  title: { absolute: "Вход на сайт — bro" },
  // The link is a secret; a chat app that previews it must not index it.
  robots: { follow: false, index: false },
};

/**
 * The window where the person signs in to a site themselves, from a link Bro
 * sent (docs/login-handoff.md). The page only shows; everything it does goes
 * through `/eve/v1/login-handoff/<id>`, and reading the link takes nothing.
 */
export default async function Page(props: PageProps<"/handoff/[id]">) {
  const { id } = await props.params;
  return (
    <div className="flex min-h-svh flex-col">
      {/* A task flow for one person: the wordmark alone, no site navigation. */}
      <Capsule items={[]} />
      <main className="mx-auto w-full max-w-[72rem] flex-1 px-bro-pad pt-[5.5rem] pb-12">
        <Viewer id={id} />
      </main>
    </div>
  );
}
