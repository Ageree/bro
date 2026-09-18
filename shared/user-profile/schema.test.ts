import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  defaultTimeZone,
  emptyUserProfile,
  hasUserProfileValues,
  isSupportedTimeZone,
  parseUserProfile,
  resolveTimeZone,
  userProfilePatchSchema,
} from "@shared/user-profile/schema";

describe("user profile", () => {
  it("validates and normalizes form-ready personal information", () => {
    expect(
      parseUserProfile({
        ...emptyUserProfile,
        countryCode: "us",
        dateOfBirth: "1990-01-02",
        email: "person@example.com",
      })
    ).toEqual({
      ...emptyUserProfile,
      countryCode: "US",
      dateOfBirth: "1990-01-02",
      email: "person@example.com",
    });
  });

  it("supports explicit field removal without accepting empty updates", () => {
    expect(userProfilePatchSchema.parse({ phone: null })).toEqual({
      phone: null,
    });
    expect(userProfilePatchSchema.safeParse({}).success).toBe(false);
    expect(hasUserProfileValues(emptyUserProfile)).toBe(false);
    expect(
      hasUserProfileValues({ ...emptyUserProfile, city: "Brooklyn" })
    ).toBe(true);
  });

  it("accepts only a time zone this runtime actually knows", () => {
    expect(isSupportedTimeZone("Europe/Moscow")).toBe(true);
    expect(isSupportedTimeZone("Asia/Novosibirsk")).toBe(true);
    expect(isSupportedTimeZone("Москва")).toBe(false);
    expect(isSupportedTimeZone("UTC+3")).toBe(false);
    expect(isSupportedTimeZone("")).toBe(false);

    expect(
      userProfilePatchSchema.parse({ timezone: " Asia/Yekaterinburg " })
    ).toEqual({ timezone: "Asia/Yekaterinburg" });
    expect(
      userProfilePatchSchema.safeParse({ timezone: "Mars/Olympus" }).success
    ).toBe(false);
    expect(userProfilePatchSchema.parse({ timezone: null })).toEqual({
      timezone: null,
    });
  });

  it("falls back to Moscow for a missing or stale zone", () => {
    expect(defaultTimeZone).toBe("Europe/Moscow");
    expect(resolveTimeZone("Asia/Omsk")).toBe("Asia/Omsk");
    expect(resolveTimeZone(null)).toBe(defaultTimeZone);
    expect(resolveTimeZone("Mars/Olympus")).toBe(defaultTimeZone);
  });

  it("keeps model-facing email validation free of unsupported lookaround", () => {
    expect(
      userProfilePatchSchema.safeParse({ email: "not-an-email" }).success
    ).toBe(false);
    expect(
      JSON.stringify(z.toJSONSchema(userProfilePatchSchema))
    ).not.toContain("(?=");
  });
});
