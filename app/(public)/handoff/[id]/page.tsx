import type { Metadata } from "next";
import { Masthead } from "@web/components/paper/masthead";
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
      <Masthead />
      <main className="mx-auto w-full max-w-[72rem] px-bro-pad pt-[0.6rem] pb-12">
        <Viewer id={id} />
      </main>
    </div>
  );
}
