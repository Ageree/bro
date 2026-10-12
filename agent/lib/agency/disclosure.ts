import type { UserProfile } from "@shared/user-profile/schema";

/** The person's home, as the profile writes it. */
type HomeDetails = Pick<UserProfile, "addressLine1" | "addressLine2" | "phone">;

/** Shorter address lines are too common a word to be a home address. */
const minimumAddressLength = 6;

/** The digits that identify a Russian phone, with or without its country code. */
const phoneDigits = 10;

/** Lower case, «ё» as «е», every other run of characters as one space. */
function normalised(value: string) {
  return value
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Whether `phrase` appears in `text` as whole words. */
function containsWords(text: string, phrase: string) {
  return ` ${text} `.includes(` ${phrase} `);
}

function digitsOf(value: string) {
  return value.replace(/\D/gu, "");
}

/**
 * Whether outbound `text` gives out a detail of the person's home (an address
 * line, a phone number) that `goal` does not name itself. A detail the goal
 * names is the person's to share; any other is not Bro's to send on.
 */
export function disclosesHomeDetail(input: {
  readonly goal?: string;
  readonly profile: HomeDetails;
  readonly text: string;
}) {
  const goal = input.goal ?? "";
  const text = normalised(input.text);
  const goalText = normalised(goal);
  const addresses = [input.profile.addressLine1, input.profile.addressLine2]
    .map((line) => normalised(line ?? ""))
    .filter((line) => line.length >= minimumAddressLength);
  if (
    addresses.some(
      (line) => containsWords(text, line) && !containsWords(goalText, line)
    )
  ) {
    return true;
  }
  const phone = digitsOf(input.profile.phone ?? "").slice(-phoneDigits);
  return (
    phone.length === phoneDigits &&
    digitsOf(input.text).includes(phone) &&
    !digitsOf(goal).includes(phone)
  );
}
