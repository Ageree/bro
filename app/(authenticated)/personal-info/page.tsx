import type { Metadata } from "next";
import { PersonalInfoForm } from "./_components/personal-info-form";
import { readUserProfile } from "@db/services/user-profile";
import { requireRequestScope } from "@web/auth/request-scope";

export const metadata: Metadata = { title: "Личные данные" };

export default async function Page() {
  const scope = await requireRequestScope();
  return <PersonalInfoForm initialProfile={await readUserProfile(scope)} />;
}
