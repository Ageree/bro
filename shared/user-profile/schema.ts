import { z } from "zod";

const nullableText = (maximum: number) =>
  z.string().trim().min(1).max(maximum).nullable();
const emailAddress = z
  .string()
  .trim()
  .min(3)
  .max(320)
  .refine((value) => z.email().safeParse(value).success, {
    message: "Invalid email address",
  });

/**
 * Metering, scheduling and «сегодня» all need one zone name, and this is where
 * it is settled. Moscow is the default because that is where the product's
 * people are, not because the runtime happens to live there.
 */
export const defaultTimeZone = "Europe/Moscow";

// Built once: `Intl.supportedValuesOf` allocates a fresh array of ~400 names
// on every call, and this runs on each profile write and each metered message.
let supportedTimeZones: Set<string> | undefined;

/** True when `value` is an IANA zone this runtime's ICU data actually knows. */
export function isSupportedTimeZone(value: string) {
  supportedTimeZones ??= new Set(Intl.supportedValuesOf("timeZone"));
  return supportedTimeZones.has(value);
}

/** The stored zone, or Moscow when it is missing or no longer a real zone. */
export function resolveTimeZone(value: string | null | undefined) {
  return value && isSupportedTimeZone(value) ? value : defaultTimeZone;
}

export const userProfileSchema = z.object({
  addressLine1: nullableText(300),
  addressLine2: nullableText(300),
  city: nullableText(200),
  countryCode: z
    .string()
    .trim()
    .length(2)
    .regex(/^[A-Za-z]{2}$/u)
    .nullable(),
  dateOfBirth: z.iso.date().nullable(),
  email: emailAddress.nullable(),
  firstName: nullableText(200),
  lastName: nullableText(200),
  phone: nullableText(100),
  postalCode: nullableText(100),
  region: nullableText(200),
  timezone: z
    .string()
    .trim()
    .refine(isSupportedTimeZone, "Unknown IANA time zone")
    .nullable(),
});

export const userProfilePatchSchema = userProfileSchema
  .partial()
  .refine((profile) => Object.keys(profile).length > 0, {
    message: "Provide at least one profile field to update or remove.",
  });

export type UserProfile = z.infer<typeof userProfileSchema>;
export type UserProfilePatch = z.infer<typeof userProfilePatchSchema>;

export const emptyUserProfile = {
  addressLine1: null,
  addressLine2: null,
  city: null,
  countryCode: null,
  dateOfBirth: null,
  email: null,
  firstName: null,
  lastName: null,
  phone: null,
  postalCode: null,
  region: null,
  timezone: null,
} satisfies UserProfile;

export function hasUserProfileValues(profile: UserProfile) {
  return Object.values(profile).some((value) => value !== null);
}

export function parseUserProfile(input: UserProfile) {
  const profile = userProfileSchema.parse(input);
  return {
    ...profile,
    countryCode: profile.countryCode?.toUpperCase() ?? null,
  } satisfies UserProfile;
}
